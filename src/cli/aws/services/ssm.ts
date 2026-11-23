/* aws ssm — Systems Manager のマネージドノードと Session Manager (セッション・設定)
   start-session は、実物では PC に Session Manager プラグインが要る。この学習環境では入れなくても動き、
   ターミナルがインスタンスのシェル (sh-5.2$、ssm-user) に切り替わる (exit で戻る) */
import { managedNodes, pingStatus, PREFERENCES_DOCUMENT, preferencesDocument, startSession, terminateSession, updatePreferences, type ManagedNode, type SessionPreferences, type SsmSession } from '../../../sim/ext/ssm';
import { AwsError, iso, list, ParamError, req, service, str, structs, type OpContext, type OperationSpec } from '../types';

const NODE_FIELDS: Record<string, (n: ManagedNode) => string[]> = {
  InstanceIds: (n) => [n.instance.instanceId],
  PingStatus: (n) => [n.pingStatus],
  PlatformTypes: (n) => [n.platformType],
  ResourceType: () => ['EC2Instance'],
  AgentVersion: (n) => [n.agentVersion],
  'tag-key': (n) => n.instance.tags.map((t) => t.key),
};

/** --filters (Key / Values) と古い --instance-information-filter-list (key / valueSet) */
function nodes(ctx: OpContext): ManagedNode[] {
  const filters = [...structs(ctx, 'filters').map((f) => ({ key: String(f.Key ?? ''), values: list(f.Values) })), ...structs(ctx, 'instance-information-filter-list').map((f) => ({ key: String(f.key ?? ''), values: list(f.valueSet) }))];
  const field = (key: string, n: ManagedNode) => (key.startsWith('tag:') ? n.instance.tags.filter((t) => t.key === key.slice(4)).map((t) => t.value) : NODE_FIELDS[key](n));
  for (const f of filters) if (!f.key.startsWith('tag:') && !NODE_FIELDS[f.key]) throw new AwsError('InvalidInstanceInformationFilterValue', `${f.key} is not a valid filter key.`);
  return managedNodes(ctx.env, ctx.now).filter((n) => filters.every((f) => f.values.some((v) => field(f.key, n).includes(v))));
}

/** この学習環境の aws は IAM ユーザー learner (セッション ID の頭と Owner になる) */
const owner = (ctx: OpContext) => ({ userName: 'learner', ownerArn: `arn:aws:iam::${ctx.env.accountId}:user/learner` });

const SESSION_FILTERS: Record<string, (s: SsmSession, v: string) => boolean> = {
  Target: (s, v) => s.target === v,
  Owner: (s, v) => s.owner === v,
  Status: (s, v) => s.status === v,
  SessionId: (s, v) => s.sessionId === v,
  InvokedAfter: (s, v) => s.startDate >= Date.parse(v),
  InvokedBefore: (s, v) => s.startDate < Date.parse(v),
  AccessType: (_, v) => v === 'Standard',
};

const sessionOut = (ctx: OpContext, s: SsmSession) => ({
  SessionId: s.sessionId,
  Target: s.target,
  Status: s.status,
  StartDate: iso(s.startDate),
  ...(s.endDate ? { EndDate: iso(s.endDate) } : {}),
  DocumentName: PREFERENCES_DOCUMENT,
  Owner: s.owner,
  ...(s.reason ? { Reason: s.reason } : {}),
  OutputUrl: s.logGroupName && s.status === 'Terminated' ? { CloudWatchOutputUrl: `https://console.aws.amazon.com/cloudwatch/home?region=${ctx.env.region}#logEventViewer:group=${s.logGroupName};stream=${s.sessionId}` } : {},
  AccessType: 'Standard',
});

const ops: OperationSpec[] = [
  {
    name: 'describe-instance-information',
    desc: 'マネージドノード (SSM Agent が登録できたインスタンス) の一覧。PingStatus が Online ならセッションを開始できる',
    params: [
      { name: 'filters', type: 'list', of: 'structure', desc: '絞り込み。例: Key=PingStatus,Values=Online / Key=InstanceIds,Values=i-...' },
      { name: 'instance-information-filter-list', type: 'list', of: 'structure', desc: '古い書き方の絞り込み。例: key=PingStatus,valueSet=Online' },
    ],
    readOnly: true,
    examples: ["aws ssm describe-instance-information --query 'InstanceInformationList[].[InstanceId,PingStatus,PlatformName]' --output table"],
    run: (ctx) => ({
      InstanceInformationList: nodes(ctx).map((n) => ({
        InstanceId: n.instance.instanceId,
        PingStatus: n.pingStatus,
        LastPingDateTime: iso(n.lastPingAt),
        AgentVersion: n.agentVersion,
        IsLatestVersion: true,
        PlatformType: n.platformType,
        PlatformName: n.platformName,
        PlatformVersion: n.platformVersion,
        ResourceType: 'EC2Instance',
        IPAddress: n.instance.privateIpAddress,
        ComputerName: n.computerName,
        SourceId: n.instance.instanceId,
        SourceType: 'AWS::EC2::Instance',
      })),
    }),
  },
  {
    name: 'get-connection-status',
    desc: 'ノードにセッションを開始できるか (connected / notconnected)',
    params: [{ name: 'target', type: 'string', required: true, desc: 'インスタンス ID' }],
    readOnly: true,
    run: (ctx) => ({ Target: req(ctx, 'target'), Status: pingStatus(ctx.env, req(ctx, 'target')) === 'Online' ? 'connected' : 'notconnected' }),
  },
  {
    name: 'start-session',
    desc: 'ノードとのセッションを開始し、そのシェルに入る (ポート 22 もパブリック IP も要らない。exit で戻る)',
    params: [
      { name: 'target', type: 'string', required: true, desc: 'インスタンス ID' },
      { name: 'reason', type: 'string', desc: 'セッションの理由 (履歴に残る)' },
      { name: 'document-name', type: 'string', desc: `セッションのドキュメント (このシミュレーターは ${PREFERENCES_DOCUMENT} = シェルだけ)` },
    ],
    raw: true,
    examples: ['aws ssm start-session --target i-0123456789abcdef0'],
    run(ctx) {
      const doc = str(ctx, 'document-name');
      if (doc && doc !== PREFERENCES_DOCUMENT) throw new ParamError(`(シミュレーター) --document-name は ${PREFERENCES_DOCUMENT} (シェル) だけに対応しています。ポート転送などは未対応です`);
      const id = startSession(ctx.env, { target: req(ctx, 'target'), reason: str(ctx, 'reason'), ...owner(ctx) }, ctx.now);
      ctx.terminal.connect(id);
      return `\nStarting session with SessionId: ${id}\n\x1b[2m(シミュレーター) 実物の AWS CLI では Session Manager プラグインのインストールが必要です。exit でセッションを終えて PC に戻ります\x1b[0m`;
    },
  },
  {
    name: 'terminate-session',
    desc: 'セッションを終了する',
    params: [{ name: 'session-id', type: 'string', required: true, desc: 'セッション ID (describe-sessions で調べる)' }],
    run(ctx) {
      terminateSession(ctx.env, req(ctx, 'session-id'), ctx.now);
      return { SessionId: req(ctx, 'session-id') };
    },
  },
  {
    name: 'describe-sessions',
    desc: 'セッションの一覧 (Active = 接続中 / History = 終了したもの)',
    params: [
      { name: 'state', type: 'string', required: true, desc: 'Active / History' },
      { name: 'filters', type: 'list', of: 'structure', desc: '絞り込み。例: key=Target,value=i-... / key=Owner,value=arn:... / key=Status,value=Terminated' },
    ],
    readOnly: true,
    examples: ["aws ssm describe-sessions --state History --query 'Sessions[].[SessionId,Target,Status,StartDate]' --output table"],
    run(ctx) {
      const st = req(ctx, 'state');
      if (st !== 'Active' && st !== 'History') throw new AwsError('ValidationException', `1 validation error detected: Value '${st}' at 'state' failed to satisfy constraint: Member must satisfy enum value set: [Active, History]`);
      const filters = structs(ctx, 'filters').map((f) => ({ key: String(f.key ?? ''), value: String(f.value ?? '') }));
      for (const f of filters) if (!SESSION_FILTERS[f.key]) throw new AwsError('ValidationException', `1 validation error detected: Value '${f.key}' at 'filters.1.member.key' failed to satisfy constraint: Member must satisfy enum value set: [InvokedAfter, InvokedBefore, Target, Owner, Status, SessionId, AccessType]`);
      const list = (ctx.env.ssm?.sessions ?? []).filter((s) => (st === 'Active' ? s.status === 'Connected' : s.status === 'Terminated') && filters.every((f) => SESSION_FILTERS[f.key](s, f.value)));
      return { Sessions: [...list].reverse().map((s) => sessionOut(ctx, s)) };
    },
  },
  {
    name: 'get-document',
    desc: `SSM ドキュメントの中身 (このシミュレーターは Session Manager の設定 ${PREFERENCES_DOCUMENT} だけ)`,
    params: [
      { name: 'name', type: 'string', required: true, desc: PREFERENCES_DOCUMENT },
      { name: 'document-version', type: 'string', desc: 'バージョン (省略すると最新)' },
    ],
    readOnly: true,
    examples: [`aws ssm get-document --name ${PREFERENCES_DOCUMENT} --query Content --output text`],
    run(ctx) {
      if (req(ctx, 'name') !== PREFERENCES_DOCUMENT || !ctx.env.ssm) throw new AwsError('InvalidDocument', `Document with name ${req(ctx, 'name')} does not exist.`);
      return { Name: PREFERENCES_DOCUMENT, CreatedDate: iso(ctx.env.ssm.documentCreatedAt), DocumentVersion: String(ctx.env.ssm.documentVersion), Status: 'Active', Content: preferencesDocument(ctx.env), DocumentType: 'Session', DocumentFormat: 'JSON' };
    },
  },
  {
    name: 'update-document',
    desc: `SSM ドキュメントを更新する。${PREFERENCES_DOCUMENT} を更新すると Session Manager の設定 (ログの送り先など) が変わる`,
    params: [
      { name: 'name', type: 'string', required: true, desc: PREFERENCES_DOCUMENT },
      { name: 'content', type: 'string', required: true, desc: 'ドキュメントの JSON (file://SessionManagerRunShell.json)' },
      { name: 'document-version', type: 'string', desc: "更新するバージョン ('$LATEST')" },
    ],
    examples: [`aws ssm update-document --name ${PREFERENCES_DOCUMENT} --content file://SessionManagerRunShell.json --document-version '$LATEST'`],
    run(ctx) {
      if (req(ctx, 'name') !== PREFERENCES_DOCUMENT || !ctx.env.ssm) throw new AwsError('InvalidDocument', `Document with name ${req(ctx, 'name')} does not exist.`);
      let doc: { sessionType?: string; inputs?: Partial<SessionPreferences> };
      try {
        doc = JSON.parse(req(ctx, 'content'));
      } catch {
        throw new AwsError('InvalidDocumentContent', 'Document content is not valid JSON.');
      }
      if (doc.sessionType !== 'Standard_Stream' || typeof doc.inputs !== 'object') throw new AwsError('InvalidDocumentContent', 'sessionType must be Standard_Stream and inputs must be an object.');
      const version = String(updatePreferences(ctx.env, doc.inputs, ctx.now));
      return { DocumentDescription: { Status: 'Updating', Name: PREFERENCES_DOCUMENT, Tags: [], DocumentType: 'Session', PlatformTypes: ['Windows', 'Linux', 'MacOS'], DocumentVersion: version, HashType: 'Sha256', CreatedDate: iso(ctx.env.ssm.documentCreatedAt), Owner: ctx.env.accountId, SchemaVersion: '1.0', DefaultVersion: '1', DocumentFormat: 'JSON', LatestVersion: version } };
    },
  },
];

export default service('ssm', 'AWS Systems Manager (マネージドノード・Session Manager)', ops);
