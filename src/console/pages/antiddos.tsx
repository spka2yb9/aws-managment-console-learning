// WAF & Shield: adding / editing managed rule groups (the Anti-DDoS rule group's settings), rule priority, and the
// web ACL's traffic graph (lesson 42). The web ACL page itself is in edge.tsx.
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import { useState } from 'react';
import { MANAGED_RULE_GROUPS, updateWebAcl } from '../../sim/edge';
import { ANTI_DDOS, ANTI_DDOS_RULES, defaultAntiDdosConfig, WAF_METRICS, wafMetricData } from '../../sim/ext/antiddos';
import type { AntiDdosConfig, AwsError, RuleActionOverride, WafRule, WafSensitivity, WebAcl } from '../../sim/types';
import { useConsole } from '../store';
import { EditForm, NotFound, useGlobalEnv, useNavigate } from '../ui';
import { Graph, useNow } from './cloudwatch';

const aclPath = (name: string) => `/wafv2/webacls/${name}`;

/** AllowedRequests / BlockedRequests / ChallengeRequests / CountedRequests of the last 30 minutes */
export function WafTrafficGraph({ acl }: { acl: WebAcl }) {
  const env = useGlobalEnv();
  const now = useNow();
  const start = now - 30 * 60_000;
  return (
    <Container header={<Header variant="h2" description="直近 30 分。1 分ごとのリクエスト数 (CloudWatch の AWS/WAFV2 メトリクス)">リクエスト</Header>}>
      <div data-testid="waf-traffic">
        <Graph series={WAF_METRICS.map(([metric, , label]) => ({ label: `${label} (${metric})`, data: wafMetricData(env, acl, metric, start, now) }))} start={start} end={now} unit="Count" />
      </div>
    </Container>
  );
}

const SENSITIVITY: { value: WafSensitivity; label: string; description: string }[] = [
  { value: 'LOW', label: '低', description: '疑いが高い (high-suspicion) リクエストだけに一致します' },
  { value: 'MEDIUM', label: '中', description: '疑いが中 (medium) 以上のリクエストに一致します' },
  { value: 'HIGH', label: '高', description: '疑いのあるリクエスト (low / medium / high) すべてに一致します' },
];
const OVERRIDE_LABEL: Record<string, string> = { Allow: '許可 (Allow)', Block: 'ブロック (Block)', Count: 'カウント (Count)', Challenge: 'チャレンジ (Challenge)' };

/** "ルールグループの設定" + "ルール" of AWSManagedRulesAntiDDoSRuleSet */
function AntiDdosSettings({ cfg, setCfg, overrides, setOverrides }: { cfg: AntiDdosConfig; setCfg: (c: AntiDdosConfig) => void; overrides: RuleActionOverride[]; setOverrides: (o: RuleActionOverride[]) => void }) {
  const ch = cfg.challenge;
  const setChallenge = (c: Partial<AntiDdosConfig['challenge']>) => setCfg({ ...cfg, challenge: { ...ch, ...c } });
  const overrideOf = (name: string) => overrides.find((o) => o.name === name)?.action;
  const setOverride = (name: string, action?: RuleActionOverride['action']) => setOverrides([...overrides.filter((o) => o.name !== name), ...(action ? [{ name, action }] : [])]);
  return (
    <>
      <Container header={<Header variant="h2" description="AWSManagedRulesAntiDDoSRuleSet: DDoS 攻撃をどれだけ敏感に見分けるか、疑わしいリクエストをどう扱うか">ルールグループの設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="ブロックの感度レベル" description="ルール DDoSRequests がブロックする範囲です。感度が高いほど、疑いの低いリクエストまでブロックします。">
            <RadioGroup value={cfg.sensitivityToBlock} onChange={(e) => setCfg({ ...cfg, sensitivityToBlock: e.detail.value as WafSensitivity })} items={SENSITIVITY} ariaLabel="ブロックの感度レベル" />
          </FormField>
          <FormField label="チャレンジ" description="ルール ChallengeAllDuringEvent と ChallengeDDoSRequests を使います。ブラウザは JavaScript で自動的にチャレンジを解いて通れますが、JavaScript を実行しないクライアントは通れません。">
            <Toggle checked={ch.usage === 'ENABLED'} onChange={(e) => setChallenge({ usage: e.detail.checked ? 'ENABLED' : 'DISABLED' })} data-testid="antiddos-challenge-toggle">
              チャレンジを有効にする
            </Toggle>
          </FormField>
          {ch.usage === 'ENABLED' && (
            <>
              <FormField label="チャレンジの感度レベル" description="イベント中、ChallengeAllDuringEvent をカウントにしたときに ChallengeDDoSRequests がチャレンジする範囲です。">
                <RadioGroup value={ch.sensitivity} onChange={(e) => setChallenge({ sensitivity: e.detail.value as WafSensitivity })} items={SENSITIVITY} ariaLabel="チャレンジの感度レベル" />
              </FormField>
              <FormField
                label="除外 URI の正規表現"
                description="サイレントブラウザチャレンジを処理できないリクエスト (API、アプリ、画像など) の URI に一致させる正規表現 (最大 5 個)。ホスト名に続く正規化されたパス (例: d111111abcdef8.cloudfront.net/api/orders) と照合するので、^/api/ のようにパスの先頭に固定した正規表現は一致しません。"
              >
                <Hotspot hotspotId="waf-antiddos-exempt" direction="right">
                  <SpaceBetween size="xs">
                    {ch.exemptUriRegex.map((r, i) => (
                      <div key={i} className="input-with-suffix" data-testid={`antiddos-exempt-${i}`}>
                        <Input value={r} onChange={(e) => setChallenge({ exemptUriRegex: ch.exemptUriRegex.map((x, j) => (j === i ? e.detail.value : x)) })} ariaLabel={`除外 URI の正規表現 ${i + 1}`} />
                        <Button formAction="none" onClick={() => setChallenge({ exemptUriRegex: ch.exemptUriRegex.filter((_, j) => j !== i) })}>削除</Button>
                      </div>
                    ))}
                    <Button formAction="none" disabled={ch.exemptUriRegex.length >= 5} onClick={() => setChallenge({ exemptUriRegex: [...ch.exemptUriRegex, ''] })} data-testid="antiddos-exempt-add">
                      正規表現を追加
                    </Button>
                  </SpaceBetween>
                </Hotspot>
              </FormField>
            </>
          )}
        </SpaceBetween>
      </Container>
      <Table
        variant="container"
        data-testid="antiddos-rules"
        header={
          <Header
            variant="h2"
            description="ルールのアクションを上書きできます。試すときはすべてカウントにして、止めずにラベルと一致だけを記録します。"
            actions={
              <Hotspot hotspotId="waf-antiddos-override-all" direction="left">
                <Select
                  selectedOption={null}
                  placeholder="すべてのルールアクションをオーバーライド"
                  options={[{ value: 'Count', label: 'カウント (Count)' }, { value: '', label: 'すべてのオーバーライドを削除' }]}
                  onChange={(e) => setOverrides(e.detail.selectedOption.value ? ANTI_DDOS_RULES.map((r) => ({ name: r.name, action: 'Count' as const })) : [])}
                  data-testid="antiddos-override-all"
                />
              </Hotspot>
            }
          >
            ルール
          </Header>
        }
        items={ANTI_DDOS_RULES}
        columnDefinitions={[
          { id: 'name', header: 'ルール', cell: (r) => r.name },
          { id: 'own', header: 'ルールのアクション', cell: (r) => r.action },
          {
            id: 'override',
            header: 'アクションのオーバーライド',
            cell: (r) => {
              const v = overrideOf(r.name);
              return (
                <Select
                  selectedOption={{ value: v ?? '', label: v ? OVERRIDE_LABEL[v] : `オーバーライドしない (${r.action})` }}
                  options={[{ value: '', label: `オーバーライドしない (${r.action})` }, ...r.overrides.map((o) => ({ value: o, label: OVERRIDE_LABEL[o] }))]}
                  onChange={(e) => setOverride(r.name, (e.detail.selectedOption.value || undefined) as RuleActionOverride['action'] | undefined)}
                  ariaLabel={`${r.name} のアクション`}
                />
              );
            },
          },
        ]}
      />
    </>
  );
}

/** "ルールの優先度を設定": the order the web ACL evaluates its rules (top = first) */
function PriorityList({ names, setNames, highlight }: { names: string[]; setNames: (n: string[]) => void; highlight?: string }) {
  const [selected, setSelected] = useState(highlight ?? '');
  const i = names.indexOf(selected);
  const move = (d: number) => {
    const next = [...names];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setNames(next);
  };
  return (
    <Table
      variant="container"
      data-testid="waf-priority"
      header={
        <Header
          variant="h2"
          description="上から順に評価し、最初に一致したルールのアクションで決まります。"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Hotspot hotspotId="waf-move-up" direction="left">
                <Button formAction="none" disabled={i <= 0} onClick={() => move(-1)} data-testid="waf-move-up">上に移動</Button>
              </Hotspot>
              <Button formAction="none" disabled={i < 0 || i >= names.length - 1} onClick={() => move(1)} data-testid="waf-move-down">下に移動</Button>
            </SpaceBetween>
          }
        >
          ルールの優先度を設定
        </Header>
      }
      selectionType="single"
      selectedItems={i >= 0 ? [{ name: selected, n: i }] : []}
      onSelectionChange={(e) => setSelected(e.detail.selectedItems[0]?.name ?? '')}
      trackBy="name"
      ariaLabels={{ selectionGroupLabel: 'ルールの選択', itemSelectionLabel: (_, r) => `${r.name} を選択`, allItemsSelectionLabel: () => 'すべて選択' }}
      items={names.map((name, n) => ({ name, n }))}
      columnDefinitions={[
        { id: 'n', header: '優先度', cell: (r) => String(r.n) },
        { id: 'name', header: '名前', cell: (r) => r.name },
      ]}
    />
  );
}

const ruleNameOf = (group: string) => `AWS-${group}`;
const newManagedRule = (group: string, cfg: AntiDdosConfig, overrides: RuleActionOverride[]): WafRule => ({
  name: ruleNameOf(group),
  priority: 0,
  action: 'Block',
  statement: { kind: 'managed', vendor: 'AWS', name: group, ...(group === ANTI_DDOS ? { antiDdos: cfg, ruleActionOverrides: overrides } : {}) },
});

/** Add managed rule groups (adding = true) or edit one managed rule group of the web ACL, then save the whole web ACL. */
function ManagedRuleGroupForm({ acl, editing }: { acl: WebAcl; editing?: WafRule }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const editingGroup = editing?.statement.kind === 'managed' ? editing.statement : undefined;
  const has = (g: string) => acl.rules.some((r) => r.statement.kind === 'managed' && r.statement.name === g);
  const [added, setAdded] = useState<string[]>([]);
  const [cfg, setCfg] = useState<AntiDdosConfig>(editingGroup?.antiDdos ?? defaultAntiDdosConfig());
  const [overrides, setOverrides] = useState<RuleActionOverride[]>(editingGroup?.ruleActionOverrides ?? []);
  const [order, setOrder] = useState<string[]>(acl.rules.map((r) => r.name));
  const [error, setError] = useState<AwsError | null>(null);
  const toggle = (g: string, on: boolean) => {
    setAdded(on ? [...added, g] : added.filter((x) => x !== g));
    setOrder(on ? [...order, ruleNameOf(g)] : order.filter((n) => n !== ruleNameOf(g)));
  };
  const showAntiDdos = editingGroup ? editingGroup.name === ANTI_DDOS : added.includes(ANTI_DDOS);
  const back = `${aclPath(acl.name)}?tab=rules`;
  const save = () => {
    const rules = new Map<string, WafRule>(acl.rules.map((r) => [r.name, r]));
    for (const g of added) rules.set(ruleNameOf(g), newManagedRule(g, cfg, overrides));
    if (editing && editingGroup) rules.set(editing.name, { ...editing, statement: { ...editingGroup, ...(editingGroup.name === ANTI_DDOS ? { antiDdos: cfg, ruleActionOverrides: overrides } : {}) } });
    const next = order.map((n, priority) => ({ ...rules.get(n)!, priority }));
    const r = run((d) => updateWebAcl(d, acl.arn, { rules: next }), `ウェブ ACL ${acl.name} を更新しました`);
    if (r.ok) navigate(back);
    else setError(r.error);
  };
  return (
    <EditForm
      title={editing ? `${editing.name} を編集` : 'マネージドルールグループを追加'}
      description={editing ? undefined : `ウェブ ACL ${acl.name} に AWS マネージドルールグループを追加します。`}
      submitText="保存"
      submitTestId="waf-rules-save"
      submitHotspotId="waf-rules-save"
      onCancel={() => navigate(back)}
      onSubmit={save}
      error={error}
    >
      {!editing && (
        <Table
          variant="container"
          data-testid="managed-rule-groups"
          header={<Header variant="h2" description="AWS が作成して更新し続けるルールグループです。有料のものは、ウェブ ACL の料金に加えて追加料金がかかります。">AWS マネージドルールグループ</Header>}
          items={MANAGED_RULE_GROUPS}
          columnDefinitions={[
            { id: 'name', header: '名前', cell: (g) => <SpaceBetween size="xxxs"><Box fontWeight="bold">{g.label}{g.paid ? ' (有料)' : ''}</Box><Box variant="small">{g.name}</Box></SpaceBetween> },
            { id: 'wcu', header: 'キャパシティ', cell: (g) => String(g.capacity) },
            { id: 'desc', header: '説明', cell: (g) => g.description },
            {
              id: 'add',
              header: 'アクション',
              cell: (g) => {
                const t = (
                  <Toggle checked={has(g.name) || added.includes(g.name)} disabled={has(g.name)} onChange={(e) => toggle(g.name, e.detail.checked)} data-testid={`add-${g.name}`}>
                    ウェブ ACL に追加
                  </Toggle>
                );
                return g.name === ANTI_DDOS ? <Hotspot hotspotId="waf-antiddos-toggle" direction="left">{t}</Hotspot> : t;
              },
            },
          ]}
        />
      )}
      {showAntiDdos && <AntiDdosSettings cfg={cfg} setCfg={setCfg} overrides={overrides} setOverrides={setOverrides} />}
      <PriorityList names={order} setNames={setOrder} highlight={editing?.name ?? (added.length ? ruleNameOf(added.at(-1)!) : undefined)} key={added.join(',')} />
    </EditForm>
  );
}

export function AddManagedRuleGroups({ name }: { name: string }) {
  const env = useGlobalEnv();
  const acl = env.webAcls.find((a) => a.name === name);
  return acl ? <ManagedRuleGroupForm acl={acl} /> : <NotFound what="ウェブ ACL" id={name} />;
}

export function EditManagedRuleGroup({ name, rule }: { name: string; rule: string }) {
  const env = useGlobalEnv();
  const acl = env.webAcls.find((a) => a.name === name);
  const r = acl?.rules.find((x) => x.name === rule);
  if (!acl || !r) return <NotFound what="ルール" id={rule} />;
  return <ManagedRuleGroupForm acl={acl} editing={r} />;
}
