import { describe, expect, it } from 'vitest';
import { execCli } from './cli';
import { byName, getDb } from './env';
import { automatedSnapshots, createDbSnapshot, currentTables, latestRestorableTime, modifyDbInstance, restoreDbInstanceFromSnapshot, restoreDbInstanceToPointInTime, type RestoreInput } from './rds';
import { accidentEnv, backupEnv, ORDERS } from './scenarios';
import { advanceTime } from './time';
import type { AwsEnv } from './types';

const sh = (env: AwsEnv, line: string) => execCli(env, byName(env.instances, 'batch-1')!.instanceId, line, {});
const input = (env: AwsEnv, identifier: string, sgName = 'db-sg'): RestoreInput => ({ identifier, dbInstanceClass: 'db.t3.micro', dbSubnetGroupName: 'webapp-db-subnet-group', vpcSecurityGroupIds: sgName ? [byName(env.securityGroups, sgName)!.groupId] : [], publiclyAccessible: false, multiAZ: false });

describe('mysql client on the ops server', () => {
  it('connects with ~/.my.cnf, counts rows, and the migration script deletes every order', () => {
    const env = backupEnv();
    expect(sh(env, 'ls').output).toBe('migrate.sh');
    expect(sh(env, 'ls -a').output).toContain('.my.cnf');
    expect(sh(env, 'mysql -e "SELECT COUNT(*) FROM orders"').output).toBe(`+----------+\n| COUNT(*) |\n+----------+\n|  ${ORDERS} |\n+----------+`);
    expect(sh(env, 'mysql -e "SHOW TABLES"').output).toContain('| orders ');
    expect(sh(env, 'mysql -e "SELECT COUNT(*) FROM nope"').output).toBe("ERROR 1146 (42S02): Table 'webapp.nope' doesn't exist");
    expect(sh(env, 'mysql -h nowhere.example -e "SHOW TABLES"').output).toBe("ERROR 2005 (HY000): Unknown MySQL server host 'nowhere.example' (-2)");
    const run = sh(env, './migrate.sh');
    expect(run.ok).toBe(true);
    expect(run.output).toBe('[1/2] Deleting archived orders...\n[2/2] Done.');
    expect(currentTables(getDb(env, 'webapp-db')).orders).toBe(0);
  });

  it('is blocked by the security group like any other connection', () => {
    const env = backupEnv();
    const db = getDb(env, 'webapp-db');
    db.vpcSecurityGroupIds = [byName(env.securityGroups, 'web-sg')!.groupId];
    expect(sh(env, 'mysql -e "SHOW TABLES"').output).toBe(`ERROR 2003 (HY000): Can't connect to MySQL server on '${db.endpointAddress}:3306' (110)`);
  });
});

describe('RDS backup and restore', () => {
  it('snapshot -> accident -> restore into a NEW instance with the old data; rename takes over the endpoint', () => {
    const env = backupEnv();
    const now = Date.now();
    createDbSnapshot(env, 'webapp-db', 'webapp-db-before-migration', now);
    expect(getDb(env, 'webapp-db').status).toBe('backing-up');
    expect(() => restoreDbInstanceFromSnapshot(env, 'webapp-db-before-migration', input(env, 'x'), now)).toThrow(/not currently in the available state/);
    advanceTime(env, now + 10_000);
    expect(env.dbSnapshots[0].status).toBe('available');
    sh(env, './migrate.sh');
    const id = restoreDbInstanceFromSnapshot(env, 'webapp-db-before-migration', input(env, 'webapp-db-restored'), now + 10_000);
    const restored = getDb(env, id);
    expect(restored.endpointAddress).not.toBe(getDb(env, 'webapp-db').endpointAddress);
    expect(currentTables(restored).orders).toBe(ORDERS);
    advanceTime(env, now + 60_000);
    expect(sh(env, `mysql -h ${restored.endpointAddress} -u admin -psimulator-only webapp -e "SELECT COUNT(*) FROM orders"`).output).toContain(String(ORDERS));
    // swap: the restored instance takes over the name (and the endpoint the app and ~/.my.cnf use)
    modifyDbInstance(env, 'webapp-db', { newDbInstanceIdentifier: 'webapp-db-broken' }, now + 60_000);
    advanceTime(env, now + 70_000);
    modifyDbInstance(env, 'webapp-db-restored', { newDbInstanceIdentifier: 'webapp-db' }, now + 70_000);
    advanceTime(env, now + 80_000);
    expect(sh(env, 'mysql -e "SELECT COUNT(*) FROM orders"').output).toContain(String(ORDERS));
  });

  it('a restore without a security group gets the VPC default group (and the app cannot reach it)', () => {
    const env = backupEnv();
    const snap = automatedSnapshots(env, getDb(env, 'webapp-db'))[0];
    const id = restoreDbInstanceFromSnapshot(env, snap.dbSnapshotIdentifier, input(env, 'restored-default', ''));
    expect(getDb(env, id).vpcSecurityGroupIds).toEqual(env.securityGroups.filter((g) => g.groupName === 'default' && g.vpcId === byName(env.vpcs, 'webapp-vpc')!.vpcId).map((g) => g.groupId));
  });

  it('point-in-time restore gets the data from just before the accident; the daily snapshot loses more (RPO)', () => {
    const now = Date.now();
    const { env, accidentAt } = accidentEnv(now);
    expect(currentTables(getDb(env, 'webapp-db')).orders).toBe(58);
    const pitr = restoreDbInstanceToPointInTime(env, 'webapp-db', { ...input(env, 'webapp-db-pitr'), restoreTime: accidentAt - 60_000 }, now);
    expect(currentTables(getDb(env, pitr)).orders).toBe(ORDERS);
    const latest = restoreDbInstanceToPointInTime(env, 'webapp-db', input(env, 'webapp-db-latest'), now);
    expect(currentTables(getDb(env, latest)).orders).toBe(0); // latest restorable time is after the DELETE
    const daily = automatedSnapshots(env, getDb(env, 'webapp-db'), now).find((s) => Date.parse(s.snapshotCreateTime) < accidentAt)!;
    expect(daily.tables.orders).toBeLessThan(ORDERS);
    expect(() => restoreDbInstanceToPointInTime(env, 'webapp-db', { ...input(env, 'future'), restoreTime: latestRestorableTime(now) + 60_000 }, now)).toThrow(/restore time must be between/);
  });
});
