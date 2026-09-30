import { getDb, getDbSubnetGroup, getSg, getSubnet, getVpc, nameTags } from './env';
import { quietly, trail } from './cloudtrail';
import { newId, randomInt } from './ids';
import { AwsError, type AwsEnv, type DbEngine, type DbInstance, type DbSnapshot, type DbStatus } from './types';
import { allocateIp } from './vpc';

export const DB_ENGINES: Record<DbEngine, { label: string; versions: string[]; port: number }> = {
  mysql: { label: 'MySQL', versions: ['8.4.3', '8.0.40'], port: 3306 },
  postgres: { label: 'PostgreSQL', versions: ['17.2', '16.6'], port: 5432 },
};

export const DB_INSTANCE_CLASSES = [
  { cls: 'db.t4g.micro', vcpu: 2, memoryGiB: 1 },
  { cls: 'db.t3.micro', vcpu: 2, memoryGiB: 1 },
  { cls: 'db.t3.small', vcpu: 2, memoryGiB: 2 },
  { cls: 'db.t3.medium', vcpu: 2, memoryGiB: 4 },
  { cls: 'db.m7g.large', vcpu: 2, memoryGiB: 8 },
  { cls: 'db.m7g.xlarge', vcpu: 4, memoryGiB: 16 },
  { cls: 'db.m7g.2xlarge', vcpu: 8, memoryGiB: 32 },
  { cls: 'db.r7g.large', vcpu: 2, memoryGiB: 16 },
];

/** Simulated durations (real RDS: several minutes). */
export const DB_STATUS_MS: Partial<Record<DbStatus, [number, DbStatus]>> = {
  creating: [6000, 'backing-up'],
  'backing-up': [3000, 'available'],
  modifying: [3000, 'available'],
  renaming: [3000, 'available'],
  stopping: [3000, 'stopped'],
  starting: [4000, 'available'],
};

/** RDS endpoints share a per-account-and-region suffix, e.g. mydb.c9akciq32lx1.ap-northeast-1.rds.amazonaws.com */
export function endpointSuffix(env: AwsEnv): string {
  let h = 7;
  for (const c of env.accountId + env.region) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 'c' + h.toString(36).padEnd(11, 'x').slice(0, 11);
}

export function createDbSubnetGroup(env: AwsEnv, input: { name: string; description: string; vpcId: string; subnetIds: string[] }) {
  getVpc(env, input.vpcId);
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9 ._-]{1,255}$/.test(name) || name === 'default')
    throw new AwsError('InvalidParameterValue', 'The parameter DBSubnetGroupName is not a valid identifier. Must contain no more than 255 letters, numbers, periods, underscores, spaces, or hyphens.');
  if (env.dbSubnetGroups.some((g) => g.dbSubnetGroupName === name)) throw new AwsError('DBSubnetGroupAlreadyExists', `The DB subnet group '${name}' already exists.`);
  const subnets = input.subnetIds.map((id) => getSubnet(env, id));
  if (subnets.some((s) => s.vpcId !== input.vpcId)) throw new AwsError('InvalidSubnet', 'Some of the subnets to be used for this DB subnet group are in different VPCs.');
  const azs = [...new Set(subnets.map((s) => s.availabilityZone))];
  if (azs.length < 2)
    throw new AwsError('DBSubnetGroupDoesNotCoverEnoughAZs', `The DB subnet group doesn't meet Availability Zone (AZ) coverage requirement. Current AZ coverage: ${azs.join(', ') || 'none'}. Add subnets to cover at least 2 AZs.`);
  env.dbSubnetGroups.push({ dbSubnetGroupName: name, description: input.description, vpcId: input.vpcId, subnetIds: [...input.subnetIds] });
  trail(env, { source: 'rds', name: 'CreateDBSubnetGroup', resources: [['AWS::RDS::DBSubnetGroup', name]], request: { dBSubnetGroupName: name, dBSubnetGroupDescription: input.description, subnetIds: input.subnetIds }, response: { dBSubnetGroupName: name, vpcId: input.vpcId, subnetGroupStatus: 'Complete' } });
  return name;
}

export interface CreateDbInput {
  identifier: string;
  engine: DbEngine;
  engineVersion?: string;
  dbInstanceClass: string;
  masterUsername: string;
  masterPassword: string;
  dbName?: string;
  allocatedStorage: number;
  dbSubnetGroupName: string;
  vpcSecurityGroupIds: string[];
  publiclyAccessible: boolean;
  multiAZ: boolean;
  availabilityZone?: string;
  backupRetentionPeriod: number;
  privateIpAddress?: string;
}

export function checkDbIdentifier(id: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(id) || id.endsWith('-') || id.includes('--'))
    throw new AwsError(
      'InvalidParameterValue',
      'The parameter DBInstanceIdentifier is not a valid identifier. Identifiers must begin with a letter; must contain only ASCII letters, digits, and hyphens; and must not end with a hyphen or contain two consecutive hyphens.',
    );
}

export function checkMasterPassword(pw: string) {
  if (pw.length < 8) throw new AwsError('InvalidParameterValue', 'The parameter MasterUserPassword is not a valid password because it is shorter than 8 characters.');
  if (pw.length > 41) throw new AwsError('InvalidParameterValue', 'The parameter MasterUserPassword is not a valid password because it is longer than 41 characters.');
  if (/[/@" ]/.test(pw) || !/^[\x20-\x7e]+$/.test(pw)) throw new AwsError('InvalidParameterValue', "The parameter MasterUserPassword is not a valid password. Only printable ASCII characters besides '/', '@', '\"', ' ' may be used.");
}

export function createDbInstance(env: AwsEnv, input: CreateDbInput, now = Date.now()): string {
  checkDbIdentifier(input.identifier);
  const id = input.identifier.toLowerCase();
  if (env.dbInstances.some((d) => d.dbInstanceIdentifier === id)) throw new AwsError('DBInstanceAlreadyExists', 'DB instance already exists');
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/.test(input.masterUsername))
    throw new AwsError('InvalidParameterValue', 'The parameter MasterUsername is not a valid identifier. Must be 1 to 16 letters or numbers; first character must be a letter.');
  checkMasterPassword(input.masterPassword);
  if (input.allocatedStorage < 20 || input.allocatedStorage > 65536) throw new AwsError('InvalidParameterCombination', 'Invalid storage size for engine name ' + input.engine + ' and storage type gp3: ' + input.allocatedStorage);
  const group = getDbSubnetGroup(env, input.dbSubnetGroupName);
  if (!input.vpcSecurityGroupIds.length) throw new AwsError('InvalidParameterValue', 'At least one VPC security group must be specified.');
  for (const sg of input.vpcSecurityGroupIds)
    if (getSg(env, sg).vpcId !== group.vpcId) throw new AwsError('InvalidParameterCombination', `The DB instance and EC2 security group are in different VPCs. The DB instance is in ${group.vpcId} and the EC2 security group is in ${getSg(env, sg).vpcId}`);
  const subnets = group.subnetIds.map((s) => getSubnet(env, s));
  const subnet = input.availabilityZone ? subnets.find((s) => s.availabilityZone === input.availabilityZone) : subnets[randomInt(subnets.length)];
  if (!subnet) throw new AwsError('InvalidParameterCombination', `No subnets in the DB subnet group are in availability zone ${input.availabilityZone}`);
  const engine = DB_ENGINES[input.engine];
  env.dbInstances.push({
    dbInstanceIdentifier: id,
    dbiResourceId: `db-${newId('x', 26).slice(2).toUpperCase()}`,
    engine: input.engine,
    engineVersion: input.engineVersion ?? engine.versions[0],
    dbInstanceClass: input.dbInstanceClass,
    status: 'creating',
    statusChangedAt: now,
    masterUsername: input.masterUsername,
    dbName: input.dbName || undefined,
    allocatedStorage: input.allocatedStorage,
    storageType: 'gp3',
    storageEncrypted: true,
    port: engine.port,
    endpointAddress: `${id}.${endpointSuffix(env)}.${env.region}.rds.amazonaws.com`,
    dbSubnetGroupName: group.dbSubnetGroupName,
    vpcSecurityGroupIds: [...input.vpcSecurityGroupIds],
    publiclyAccessible: input.publiclyAccessible,
    multiAZ: input.multiAZ,
    availabilityZone: subnet.availabilityZone,
    subnetId: subnet.subnetId,
    privateIpAddress: input.privateIpAddress ?? allocateIp(env, subnet.subnetId),
    backupRetentionPeriod: input.backupRetentionPeriod,
    preferredBackupWindow: '17:00-17:30',
    instanceCreateTime: new Date(now).toISOString(),
    tags: nameTags(),
    data: [{ at: now, tables: {} }],
  });
  trail(env, {
    source: 'rds',
    name: 'CreateDBInstance',
    resources: [['AWS::RDS::DBInstance', id]],
    request: { dBInstanceIdentifier: id, dBInstanceClass: input.dbInstanceClass, engine: input.engine, masterUsername: input.masterUsername, masterUserPassword: 'HIDDEN_DUE_TO_SECURITY_REASONS', allocatedStorage: input.allocatedStorage, vpcSecurityGroupIds: input.vpcSecurityGroupIds, dBSubnetGroupName: group.dbSubnetGroupName, multiAZ: input.multiAZ, publiclyAccessible: input.publiclyAccessible, storageEncrypted: true },
    response: { dBInstanceIdentifier: id, dBInstanceStatus: 'creating', dBInstanceArn: `arn:aws:rds:${env.region}:${env.accountId}:db:${id}` },
  });
  return id;
}

export type DbModification = Partial<Pick<DbInstance, 'vpcSecurityGroupIds' | 'publiclyAccessible' | 'backupRetentionPeriod' | 'dbInstanceClass' | 'multiAZ'>> & { newDbInstanceIdentifier?: string };

export function modifyDbInstance(env: AwsEnv, id: string, mod: DbModification, now = Date.now()) {
  const { newDbInstanceIdentifier, ...changes } = mod;
  const db = getDb(env, id);
  if (db.status !== 'available') throw new AwsError('InvalidDBInstanceState', `Database instance is not in available state.`);
  const rename = newDbInstanceIdentifier?.trim().toLowerCase();
  if (rename && rename !== id) {
    checkDbIdentifier(rename);
    if (env.dbInstances.some((d) => d.dbInstanceIdentifier === rename)) throw new AwsError('DBInstanceAlreadyExists', 'DB instance already exists');
  }
  const vpcId = getDbSubnetGroup(env, db.dbSubnetGroupName).vpcId;
  if (changes.backupRetentionPeriod !== undefined && !(Number.isInteger(changes.backupRetentionPeriod) && changes.backupRetentionPeriod >= 0 && changes.backupRetentionPeriod <= 35)) throw new AwsError('InvalidParameterValue', 'The specified value for BackupRetentionPeriod is not valid. Specify a value from 0 to 35.');
  if (changes.vpcSecurityGroupIds) {
    if (!changes.vpcSecurityGroupIds.length) throw new AwsError('InvalidParameterValue', 'At least one VPC security group must be specified.');
    for (const sg of changes.vpcSecurityGroupIds)
      if (getSg(env, sg).vpcId !== vpcId) throw new AwsError('InvalidParameterCombination', `The DB instance and EC2 security group are in different VPCs.`);
  }
  if (changes.dbInstanceClass && changes.dbInstanceClass !== db.dbInstanceClass) {
    db.previousInstanceClass = db.dbInstanceClass;
    // the new capacity is there once "modifying" ends
    db.instanceClassChangedAt = now + DB_STATUS_MS.modifying![0];
  }
  Object.assign(db, changes);
  // Security group changes apply immediately; the instance still passes through "modifying".
  db.status = 'modifying';
  db.statusChangedAt = now;
  if (rename && rename !== id) {
    // the endpoint follows the identifier, so apps using the old name now reach whatever carries it
    db.dbInstanceIdentifier = rename;
    db.endpointAddress = `${rename}.${endpointSuffix(env)}.${env.region}.rds.amazonaws.com`;
    db.status = 'renaming';
  }
  trail(env, { source: 'rds', name: 'ModifyDBInstance', resources: [['AWS::RDS::DBInstance', id]], request: { dBInstanceIdentifier: id, ...changes, ...(rename ? { newDBInstanceIdentifier: rename } : {}), applyImmediately: true }, response: { dBInstanceIdentifier: db.dbInstanceIdentifier, dBInstanceClass: db.dbInstanceClass, dBInstanceStatus: db.status } });
}

export function stopDbInstance(env: AwsEnv, id: string, now = Date.now()) {
  const db = getDb(env, id);
  if (db.status !== 'available') throw new AwsError('InvalidDBInstanceState', `Instance ${id} is not in available state.`);
  db.status = 'stopping';
  db.statusChangedAt = now;
  trail(env, { source: 'rds', name: 'StopDBInstance', resources: [['AWS::RDS::DBInstance', id]], request: { dBInstanceIdentifier: id }, response: { dBInstanceIdentifier: id, dBInstanceStatus: 'stopping' } });
}

export function startDbInstance(env: AwsEnv, id: string, now = Date.now()) {
  const db = getDb(env, id);
  if (db.status !== 'stopped') throw new AwsError('InvalidDBInstanceState', `Instance ${id} is not stopped, it is ${db.status}.`);
  db.status = 'starting';
  db.statusChangedAt = now;
  trail(env, { source: 'rds', name: 'StartDBInstance', resources: [['AWS::RDS::DBInstance', id]], request: { dBInstanceIdentifier: id }, response: { dBInstanceIdentifier: id, dBInstanceStatus: 'starting' } });
}

export function advanceDbInstances(env: AwsEnv, now: number): boolean {
  let changed = false;
  for (const db of env.dbInstances) {
    // loop: a long gap (e.g. page reload) may pass several states at once
    for (let t = DB_STATUS_MS[db.status]; t && now - db.statusChangedAt >= t[0]; t = DB_STATUS_MS[db.status]) {
      db.statusChangedAt += t[0];
      db.status = t[1];
      changed = true;
    }
  }
  return changed;
}

// ---------- data, snapshots and restore ----------

const DAY = 86_400_000;
const MINUTE = 60_000;
/** Simulated durations (real: minutes). */
export const SNAPSHOT_MS = 5000;

export const currentTables = (db: DbInstance): Record<string, number> => db.data?.[db.data.length - 1]?.tables ?? {};
export const tablesAt = (db: DbInstance, t: number): Record<string, number> => [...(db.data ?? [])].reverse().find((d) => d.at <= t)?.tables ?? {};

/** a write that changes the data (the app, a migration script, ...) */
export function writeTables(db: DbInstance, tables: Record<string, number>, now = Date.now()) {
  // kept in time order (scenarios seed the past); equal times keep write order
  db.data = [...(db.data ?? []), { at: now, tables: { ...tables } }].sort((a, b) => a.at - b.at);
}

function checkSnapshotId(id: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,254}$/.test(id) || id.endsWith('-') || id.includes('--'))
    throw new AwsError('InvalidParameterValue', 'The parameter DBSnapshotIdentifier is not a valid identifier. Identifiers must begin with a letter; must contain only ASCII letters, digits, and hyphens; and must not end with a hyphen or contain two consecutive hyphens.');
}

function snapshotOf(env: AwsEnv, db: DbInstance, id: string, type: DbSnapshot['snapshotType'], at: number, tables: Record<string, number>): DbSnapshot {
  return {
    dbSnapshotIdentifier: id,
    dbSnapshotArn: `arn:aws:rds:${env.region}:${env.accountId}:snapshot:${id}`,
    dbInstanceIdentifier: db.dbInstanceIdentifier,
    snapshotType: type,
    status: 'available',
    statusChangedAt: at,
    snapshotCreateTime: new Date(at).toISOString(),
    engine: db.engine,
    engineVersion: db.engineVersion,
    masterUsername: db.masterUsername,
    dbName: db.dbName,
    allocatedStorage: db.allocatedStorage,
    encrypted: db.storageEncrypted,
    availabilityZone: db.availabilityZone,
    vpcId: getDbSubnetGroup(env, db.dbSubnetGroupName).vpcId,
    port: db.port,
    tables: { ...tables },
  };
}

/** CreateDBSnapshot: a manual snapshot, kept until deleted. A single-AZ instance shows "backing-up" meanwhile. */
export function createDbSnapshot(env: AwsEnv, dbId: string, snapshotId: string, now = Date.now()): string {
  const db = getDb(env, dbId);
  const id = snapshotId.trim().toLowerCase();
  checkSnapshotId(id);
  if (db.status !== 'available') throw new AwsError('InvalidDBInstanceState', `Cannot create a snapshot because the database instance ${dbId} is not currently in the available state.`);
  if (env.dbSnapshots.some((s) => s.dbSnapshotIdentifier === id)) throw new AwsError('DBSnapshotAlreadyExists', `Cannot create the snapshot because a snapshot with the identifier ${id} already exists.`);
  env.dbSnapshots.push({ ...snapshotOf(env, db, id, 'manual', now, currentTables(db)), status: 'creating' });
  db.status = 'backing-up';
  db.statusChangedAt = now;
  trail(env, { source: 'rds', name: 'CreateDBSnapshot', resources: [['AWS::RDS::DBSnapshot', id], ['AWS::RDS::DBInstance', dbId]], request: { dBSnapshotIdentifier: id, dBInstanceIdentifier: dbId }, response: { dBSnapshotIdentifier: id, status: 'creating', snapshotType: 'manual' } });
  return id;
}

export function deleteDbSnapshot(env: AwsEnv, id: string) {
  const s = env.dbSnapshots.find((x) => x.dbSnapshotIdentifier === id);
  if (!s) throw new AwsError('DBSnapshotNotFound', `DBSnapshot ${id} not found.`);
  if (s.status !== 'available') throw new AwsError('InvalidDBSnapshotState', `Cannot delete the snapshot because it is not currently in the available state.`);
  env.dbSnapshots = env.dbSnapshots.filter((x) => x !== s);
  trail(env, { source: 'rds', name: 'DeleteDBSnapshot', resources: [['AWS::RDS::DBSnapshot', id]], request: { dBSnapshotIdentifier: id }, response: { dBSnapshotIdentifier: id, status: 'deleted' } });
}

export function advanceDbSnapshots(env: AwsEnv, now: number): boolean {
  let changed = false;
  for (const s of env.dbSnapshots)
    if (s.status === 'creating' && now - s.statusChangedAt >= SNAPSHOT_MS) {
      s.status = 'available';
      s.statusChangedAt += SNAPSHOT_MS;
      changed = true;
    }
  return changed;
}

/** System (automated) snapshots: one per day in the backup window (UTC), kept for the retention period. */
export function automatedSnapshots(env: AwsEnv, db: DbInstance, now = Date.now()): DbSnapshot[] {
  if (db.backupRetentionPeriod <= 0) return [];
  const created = Date.parse(db.instanceCreateTime);
  const [h, m] = db.preferredBackupWindow.split('-')[0].split(':').map(Number);
  const out: DbSnapshot[] = [];
  for (let d = 0; d <= db.backupRetentionPeriod; d++) {
    const at = Math.floor(now / DAY) * DAY - d * DAY + (h * 60 + m) * MINUTE;
    if (at > now || at < created || at < now - db.backupRetentionPeriod * DAY) continue;
    const iso = new Date(at).toISOString();
    out.push(snapshotOf(env, db, `rds:${db.dbInstanceIdentifier}-${iso.slice(0, 10)}-${iso.slice(11, 13)}-${iso.slice(14, 16)}`, 'automated', at, tablesAt(db, at)));
  }
  return out;
}

export const findSnapshot = (env: AwsEnv, id: string, now = Date.now()) => env.dbSnapshots.find((s) => s.dbSnapshotIdentifier === id) ?? env.dbInstances.flatMap((db) => automatedSnapshots(env, db, now)).find((s) => s.dbSnapshotIdentifier === id);

/** Point-in-time restore window: transaction logs are uploaded every 5 minutes. */
export const earliestRestorableTime = (db: DbInstance, now = Date.now()) => Math.max(Date.parse(db.instanceCreateTime), now - db.backupRetentionPeriod * DAY);
export const latestRestorableTime = (now = Date.now()) => Math.floor((now - 5 * MINUTE) / 1000) * 1000;

export interface RestoreInput {
  identifier: string;
  dbInstanceClass: string;
  dbSubnetGroupName: string;
  /** empty = the VPC's default security group (like the real API, a common reason restored DBs are unreachable) */
  vpcSecurityGroupIds: string[];
  publiclyAccessible: boolean;
  multiAZ: boolean;
}

function restoreNew(env: AwsEnv, from: DbSnapshot, input: RestoreInput, now: number, event: { name: string; request: Record<string, unknown> }): string {
  const group = getDbSubnetGroup(env, input.dbSubnetGroupName);
  const sgs = input.vpcSecurityGroupIds.length ? input.vpcSecurityGroupIds : env.securityGroups.filter((g) => g.vpcId === group.vpcId && g.groupName === 'default').map((g) => g.groupId);
  const id = quietly(() =>
    createDbInstance(
      env,
      { identifier: input.identifier, engine: from.engine, engineVersion: from.engineVersion, dbInstanceClass: input.dbInstanceClass, masterUsername: from.masterUsername, masterPassword: 'restored-from-backup', dbName: from.dbName, allocatedStorage: from.allocatedStorage, dbSubnetGroupName: input.dbSubnetGroupName, vpcSecurityGroupIds: sgs, publiclyAccessible: input.publiclyAccessible, multiAZ: input.multiAZ, backupRetentionPeriod: 1 },
      now,
    ),
  );
  const db = getDb(env, id);
  db.data = [{ at: now, tables: { ...from.tables } }];
  db.storageEncrypted = from.encrypted;
  trail(env, { source: 'rds', name: event.name, resources: [['AWS::RDS::DBInstance', id]], request: { dBInstanceIdentifier: id, dBInstanceClass: input.dbInstanceClass, dBSubnetGroupName: input.dbSubnetGroupName, vpcSecurityGroupIds: sgs, multiAZ: input.multiAZ, publiclyAccessible: input.publiclyAccessible, ...event.request }, response: { dBInstanceIdentifier: id, dBInstanceStatus: 'creating' } });
  return id;
}

/** RestoreDBInstanceFromDBSnapshot: always a NEW instance (new identifier, new endpoint). */
export function restoreDbInstanceFromSnapshot(env: AwsEnv, snapshotId: string, input: RestoreInput, now = Date.now()): string {
  const snap = findSnapshot(env, snapshotId, now);
  if (!snap) throw new AwsError('DBSnapshotNotFound', `DBSnapshot not found: ${snapshotId}`);
  if (snap.status !== 'available') throw new AwsError('InvalidDBSnapshotState', `Snapshot ${snapshotId} is not currently in the available state.`);
  return restoreNew(env, snap, input, now, { name: 'RestoreDBInstanceFromDBSnapshot', request: { dBSnapshotIdentifier: snapshotId } });
}

/** RestoreDBInstanceToPointInTime: the source's data as of `restoreTime` (default: latest restorable time), into a new instance. */
export function restoreDbInstanceToPointInTime(env: AwsEnv, sourceId: string, input: RestoreInput & { restoreTime?: number }, now = Date.now()): string {
  const src = getDb(env, sourceId);
  if (src.backupRetentionPeriod <= 0) throw new AwsError('PointInTimeRestoreNotEnabled', "Source database instance doesn't have automatic backups enabled.");
  const t = input.restoreTime ?? latestRestorableTime(now);
  const earliest = earliestRestorableTime(src, now);
  const latest = latestRestorableTime(now);
  if (!Number.isFinite(t) || t < earliest || t > latest) throw new AwsError('InvalidRestoreFault', `The restore time must be between ${new Date(earliest).toISOString()} and ${new Date(latest).toISOString()}.`);
  return restoreNew(env, snapshotOf(env, src, `${sourceId}-pitr`, 'automated', t, tablesAt(src, t)), input, now, { name: 'RestoreDBInstanceToPointInTime', request: { sourceDBInstanceIdentifier: sourceId, ...(input.restoreTime === undefined ? { useLatestRestorableTime: true } : { restoreTime: new Date(t).toISOString() }) } });
}
