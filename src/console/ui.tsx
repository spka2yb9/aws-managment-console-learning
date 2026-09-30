// Shared AWS-console building blocks. Every service page is assembled from these so that list/search/
// detail/edit/copy behave identically everywhere — the same muscle memory learners need in the real console.
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Container from '@cloudscape-design/components/container';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import Form from '@cloudscape-design/components/form';
import Header from '@cloudscape-design/components/header';
import FormField from '@cloudscape-design/components/form-field';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import Pagination from '@cloudscape-design/components/pagination';
import PropertyFilter, { type PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import Tabs, { type TabsProps } from '@cloudscape-design/components/tabs';
import { useCollection } from '@cloudscape-design/collection-hooks';
import { useMemo, useState, type ReactNode } from 'react';
import { emptyEnv, nameOf } from '../sim/env';
import type { AwsEnv, Tagged } from '../sim/types';
import type { AwsError } from '../sim/types';
import { GLOBAL_SERVICES, matchRoute } from './routes';
import { useConsole, type RunResult } from './store';

/** The env as seen from the console's selected region: resources live in one region, others look empty. */
export function useEnv(): AwsEnv {
  const env = useConsole((s) => s.env);
  const region = useConsole((s) => s.region);
  return useMemo(() => (region === env.region ? env : emptyEnv(region)), [env, region]);
}

export function useNavigate() {
  return useConsole((s) => s.navigate);
}

export function queryParam(path: string, key: string): string | undefined {
  return new URLSearchParams(path.split('?')[1] ?? '').get(key) ?? undefined;
}

export function ConsoleLink({ to, children, testId }: { to: string; children: ReactNode; testId?: string }) {
  const navigate = useNavigate();
  return (
    <Link
      href={`#console:${to}`}
      data-testid={testId}
      onFollow={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </Link>
  );
}

/** `sg-0123456789abcdef0 [copy]` → "Copied". Copies are recorded so lessons can check "did you copy the ALB SG id?". */
export function CopyableValue({ value, display, testId, iconOnly }: { value: string; display?: ReactNode; testId?: string; iconOnly?: boolean }) {
  const recordCopy = useConsole((s) => s.recordCopy);
  if (!value) return <>-</>;
  return (
    <span data-testid={testId} className="copyable">
      <CopyToClipboard
        variant={iconOnly ? 'icon' : 'inline'}
        textToCopy={value}
        textToDisplay={display ?? value}
        copyButtonAriaLabel={`${value} をコピー`}
        copySuccessText="コピーしました"
        copyErrorText="コピーに失敗しました"
        onCopySuccess={() => recordCopy(value)}
        onCopyFailure={() => recordCopy(value)}
      />
    </span>
  );
}

const STATUS: Record<string, [StatusIndicatorProps.Type, string]> = {
  available: ['success', 'Available'],
  'db-available': ['success', '利用可能'],
  active: ['success', 'アクティブ'],
  running: ['success', '実行中'],
  healthy: ['success', '正常'],
  attached: ['success', 'Attached'],
  associated: ['success', 'Associated'],
  complete: ['success', '完了'],
  pending: ['pending', '保留中'],
  provisioning: ['pending', 'プロビジョニング中'],
  stopping: ['pending', '停止中'],
  'shutting-down': ['pending', 'シャットダウン中'],
  creating: ['in-progress', '作成中'],
  'backing-up': ['in-progress', 'バックアップ中'],
  renaming: ['in-progress', '名前の変更中'],
  modifying: ['in-progress', '変更中'],
  starting: ['in-progress', '起動中'],
  initial: ['pending', '初期'],
  draining: ['pending', 'ドレイン中'],
  deleting: ['pending', '削除中'],
  deleted: ['stopped', '削除済み'],
  stopped: ['stopped', '停止済み'],
  terminated: ['stopped', '終了済み'],
  detached: ['warning', 'Detached'],
  unused: ['stopped', '未使用'],
  unhealthy: ['error', '異常'],
  blackhole: ['error', 'ブラックホール'],
  unavailable: ['error', '利用不可'],
};

/** AWS state string → the same status indicator the console uses. */
export function ResourceStatus({ state }: { state: string }) {
  const [type, text] = STATUS[state] ?? ['info', state];
  return <StatusIndicator type={type}>{text}</StatusIndicator>;
}

export interface ActionItem {
  id: string;
  text: string;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}

/** "Actions ▼" with per-item handlers (items are disabled until something appropriate is selected). */
export function ActionMenu({ text = 'アクション', items, variant, testId }: { text?: string; items: (ActionItem | { text: string; items: ActionItem[] })[]; variant?: 'normal' | 'primary'; testId?: string }) {
  const flat = items.flatMap((i) => ('items' in i ? i.items : [i]));
  return (
    <span data-testid={testId}>
      <ButtonDropdown
        variant={variant}
        disabled={flat.every((i) => i.disabled)}
        items={items.map((i) =>
          'items' in i
            ? { text: i.text, items: i.items.map(({ id, text, disabled, disabledReason }) => ({ id, text, disabled, disabledReason })) }
            : { id: i.id, text: i.text, disabled: i.disabled, disabledReason: i.disabledReason },
        )}
        onItemClick={(e) => flat.find((i) => i.id === e.detail.id)?.onClick()}
      >
        {text}
      </ButtonDropdown>
    </span>
  );
}

export interface Column<T> {
  id: string;
  header: string;
  cell: (item: T) => ReactNode;
  /** plain value for sorting and filtering (omit = not sortable / filterable) */
  value?: (item: T) => string | number;
  width?: number;
}

/**
 * Table + PropertyFilter (search / filter) + sorting + Pagination via collection-hooks.
 * Free text matches any column that has a `value`; "Name = web-1"-style property tokens also work.
 */
export function ResourceTable<T extends object>({
  title,
  description,
  items,
  columns,
  trackBy,
  actions,
  selectionType = 'single',
  selectedItems,
  onSelectionChange,
  resourceName,
  pageSize = 20,
  variant = 'full-page',
  filterPlaceholder,
  testId,
  loading,
  headerVariant,
}: {
  title: string;
  description?: ReactNode;
  items: T[];
  columns: Column<T>[];
  trackBy: (item: T) => string;
  actions?: ReactNode;
  selectionType?: 'single' | 'multi' | 'none';
  selectedItems?: T[];
  onSelectionChange?: (items: T[]) => void;
  resourceName: string;
  pageSize?: number;
  variant?: TableProps.Variant;
  filterPlaceholder?: string;
  testId?: string;
  loading?: boolean;
  headerVariant?: 'h1' | 'h2';
}) {
  const filtering = columns.filter((c) => c.value);
  // collection-hooks filters on flat properties, so project each item to its column values.
  // row identity goes last so a column id like "key" (EC2 key pair) cannot overwrite it
  const rows = items.map((item) => ({ ...Object.fromEntries(filtering.map((c) => [c.id, c.value!(item)])), __item: item, __key: trackBy(item) }));
  type Row = (typeof rows)[number];
  const { items: visible, collectionProps, propertyFilterProps, paginationProps, filteredItemsCount } = useCollection<Row>(rows, {
    propertyFiltering: {
      filteringProperties: filtering.map((c) => ({ key: c.id, propertyLabel: c.header, groupValuesLabel: `${c.header} の値`, operators: ['=', '!=', ':', '!:'] })),
      empty: <Box textAlign="center" color="inherit" padding="l"><b>{resourceName}がありません</b><Box variant="p" color="inherit">このリージョンには{resourceName}がありません。</Box></Box>,
      noMatch: <Box textAlign="center" color="inherit" padding="l"><b>一致するものがありません</b><Box variant="p" color="inherit">一致するものが見つかりません。</Box></Box>,
    },
    sorting: {},
    pagination: { pageSize },
    selection: {},
  });
  const selectedKeys = new Set((selectedItems ?? []).map(trackBy));
  const selectedRows = rows.filter((r) => selectedKeys.has(r.__key));
  const counter = selectedRows.length && selectionType === 'multi' ? `(${selectedRows.length}/${items.length})` : `(${items.length})`;
  return (
    <div data-testid={testId}>
      <Table<Row>
        {...collectionProps}
        variant={variant}
        // No stickyHeader: Cloudscape renders a second copy of the header for it, which duplicates lesson Hotspots.
        loading={loading}
        items={visible}
        trackBy="__key"
        selectionType={selectionType === 'none' ? undefined : selectionType}
        selectedItems={selectedRows}
        onSelectionChange={(e) => onSelectionChange?.(e.detail.selectedItems.map((r) => r.__item))}
        ariaLabels={{
          selectionGroupLabel: `${resourceName}の選択`,
          itemSelectionLabel: (_, r) => `${r.__key} を選択`,
          allItemsSelectionLabel: () => 'すべて選択',
        }}
        columnDefinitions={columns.map((c) => ({ id: c.id, header: c.header, cell: (r: Row) => c.cell(r.__item), sortingField: c.value ? c.id : undefined, width: c.width }))}
        header={
          <Header variant={headerVariant ?? (variant === 'full-page' ? 'awsui-h1-sticky' : 'h2')} counter={counter} description={description} actions={actions}>
            {title}
          </Header>
        }
        filter={
          <PropertyFilter
            {...(propertyFilterProps as PropertyFilterProps)}
            filteringPlaceholder={filterPlaceholder ?? `${resourceName}をフィルタリング`}
            countText={`${filteredItemsCount ?? 0} 件の一致`}
            expandToViewport
          />
        }
        pagination={<Pagination {...paginationProps} />}
      />
    </div>
  );
}

export interface Field {
  label: string;
  value: ReactNode;
  info?: ReactNode;
}

/** "Details" container with the key/value grid used on every AWS resource page. */
export function ResourceDetail({ title = '詳細', fields, columns = 4, actions }: { title?: string; fields: Field[]; columns?: number; actions?: ReactNode }) {
  return (
    <Container header={<Header variant="h2" actions={actions}>{title}</Header>}>
      <KeyValuePairs columns={columns} items={fields.map((f) => ({ label: f.label, value: f.value || '-', info: f.info }))} />
    </Container>
  );
}

/** Tabs whose selection lives in the console path (?tab=), so returning from an edit page reopens the same tab. */
export function ResourceTabs({ tabs }: { tabs: TabsProps.Tab[] }) {
  const path = useConsole((s) => s.path);
  const navigate = useNavigate();
  const active = queryParam(path, 'tab') ?? tabs[0].id;
  return (
    <Tabs
      tabs={tabs}
      activeTabId={tabs.some((t) => t.id === active) ? active : tabs[0].id}
      onChange={(e) => navigate(`${path.split('?')[0]}?tab=${e.detail.activeTabId}`)}
    />
  );
}

export function errorText(e: AwsError | null): ReactNode {
  return e ? (
    <span data-testid="form-error">
      {e.message} <Box variant="small" color="inherit">({e.code})</Box>
    </span>
  ) : undefined;
}

/** Single-page create / edit form: header, sections, Cancel + primary action, API error shown AWS-style. */
export function EditForm({ title, description, submitText, onCancel, onSubmit, error, children, submitDisabled, submitTestId, submitHotspotId }: {
  title: string;
  description?: ReactNode;
  submitText: string;
  onCancel: () => void;
  onSubmit: () => void;
  error: AwsError | null;
  children: ReactNode;
  submitDisabled?: boolean;
  submitTestId?: string;
  /** lets a lesson point its guide at the primary button */
  submitHotspotId?: string;
}) {
  const submit = <span data-testid={submitTestId}><Button variant="primary" disabled={submitDisabled}>{submitText}</Button></span>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <Form
        header={<Header variant="h1" description={description}>{title}</Header>}
        errorText={errorText(error)}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button formAction="none" variant="link" onClick={onCancel}>キャンセル</Button>
            {submitHotspotId ? <Hotspot hotspotId={submitHotspotId} direction="right">{submit}</Hotspot> : submit}
          </SpaceBetween>
        }
      >
        <SpaceBetween size="l">{children}</SpaceBetween>
      </Form>
    </form>
  );
}

export function NotFound({ what, id }: { what: string; id: string }) {
  const path = useConsole((s) => s.path);
  const service = matchRoute(path)?.route.service;
  // global services have no Region selector to blame
  const global = !!service && GLOBAL_SERVICES.includes(service);
  return (
    <Alert type="error" header={`${what}が見つかりません`}>
      {global ? `${id || '(指定なし)'} は存在しません。削除されたか、名前や ID が間違っている可能性があります。` : `${id || '(指定なし)'} はこのリージョンに存在しません。右上のリージョンセレクターを確認するか、削除されていないか確かめてください。`}
    </Alert>
  );
}

export function nameCell(r: Tagged) {
  return nameOf(r) || '-';
}

/** Page-local table selection kept by key, so it survives env updates (items are new objects after every mutation). */
export function useSelection<T>(items: T[], key: (t: T) => string) {
  const [keys, setKeys] = useState<string[]>([]);
  const selected = items.filter((i) => keys.includes(key(i)));
  return [selected, (xs: T[]) => setKeys(xs.map(key))] as const;
}

/** Console shows local (Tokyo) time: 2026/09/26 19:00:00 (GMT+9) */
export function formatDate(iso: string | number) {
  return `${new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false })} (GMT+9)`;
}

/** IAM and the S3 bucket list are global: not filtered by the Region selector. */
export function useGlobalEnv(): AwsEnv {
  return useConsole((s) => s.env);
}

/** The console's signed-in principal (IAM user "learner"). */
export const CONSOLE_USER_ARN = (env: AwsEnv) => `arn:aws:iam::${env.accountId}:user/learner`;

export function JsonBlock({ value, testId }: { value: unknown; testId?: string }) {
  return <pre className="code-block json-block" data-testid={testId}>{JSON.stringify(value, null, 2)}</pre>;
}

/**
 * The console's destructive-action modal: type 「削除」 to enable the button.
 * onDelete runs the API call; an AWS error (e.g. DependencyViolation) stays in the modal.
 */
export function DeleteModal({ header, children, onDelete, onClose, testId = 'delete' }: { header: string; children: ReactNode; onDelete: () => RunResult<unknown>; onClose: () => void; testId?: string }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <Modal
      visible
      onDismiss={onClose}
      header={header}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>キャンセル</Button>
            <Button
              variant="primary"
              disabled={text !== '削除'}
              data-testid={`${testId}-confirm`}
              onClick={() => {
                const r = onDelete();
                if (r.ok) onClose();
                else setError(r.error);
              }}
            >
              削除
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {children}
        <FormField label="削除を確定するには、フィールドに「削除」と入力します。" errorText={errorText(error)}>
          <Input value={text} onChange={(e) => setText(e.detail.value)} placeholder="削除" data-testid={`${testId}-input`} />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
