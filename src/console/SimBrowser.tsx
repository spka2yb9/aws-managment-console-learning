import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useState } from 'react';
import type { HttpResult } from '../sim/http';
import { CLIENT_IP } from '../sim/network';
import { useConsole } from './store';

const ERROR_TEXT: Record<NonNullable<HttpResult['error']>, string> = {
  ERR_INVALID_URL: 'URL が正しくありません',
  ERR_NAME_NOT_RESOLVED: 'このサイトにアクセスできません — サーバーの DNS アドレスが見つかりませんでした。',
  ERR_CONNECTION_TIMED_OUT: 'このサイトにアクセスできません — 応答時間が長すぎます。',
  ERR_CONNECTION_REFUSED: 'このサイトにアクセスできません — 接続が拒否されました。',
  ERR_SSL_PROTOCOL_ERROR: 'このサイトは安全な接続を提供できません。',
  ERR_CERT_COMMON_NAME_INVALID: 'この接続ではプライバシーが保護されません — サーバーの証明書が、このドメインのものではありません。',
};

export function ResultView({ r }: { r: HttpResult }) {
  const ok = r.status !== undefined && r.status < 400;
  return (
    <SpaceBetween size="s">
      <div data-testid="browser-status">
        {r.status !== undefined ? (
          <StatusIndicator type={ok ? 'success' : 'error'}>HTTP {r.status} {r.statusText}</StatusIndicator>
        ) : (
          <StatusIndicator type="error">{r.error}</StatusIndicator>
        )}
      </div>
      {r.headers && (
        <Box variant="small" color="text-body-secondary">
          <span data-testid="browser-headers">{Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('  |  ')}</span>
        </Box>
      )}
      <pre className="browser-body" data-testid="browser-body">{r.status !== undefined ? r.body : `${ERROR_TEXT[r.error!]}\n${r.error}`}</pre>
      {r.hops.length > 0 && (
        <ExpandableSection headerText="通信経路の診断 (学習用)" defaultExpanded={!ok} variant="footer" data-testid="browser-trace">
          <SpaceBetween size="s">
            {r.hops.map((h, i) => (
              <div key={i}>
                <StatusIndicator type={h.ok ? 'success' : 'error'}>
                  <b>{h.hop}</b>
                </StatusIndicator>
                <ul className="trace-list">
                  {h.checks.map((c, j) => (
                    <li key={j}>
                      <StatusIndicator type={c.ok ? 'success' : 'error'}>{c.label}</StatusIndicator>
                      <Box variant="small" display="block" color="text-body-secondary">{c.detail}</Box>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </SpaceBetween>
        </ExpandableSection>
      )}
    </SpaceBetween>
  );
}

/** A browser on the learner's PC (public IP 198.51.100.24). Requests are simulated against the current environment. */
export function SimBrowser() {
  const browse = useConsole((s) => s.browse);
  const history = useConsole((s) => s.browser);
  const [url, setUrl] = useState(history[0]?.url ?? '');
  const last = history[0];
  return (
    <SpaceBetween size="m">
      <Container header={<Header variant="h3" description={`あなたのPC (Public IP ${CLIENT_IP}) のブラウザを模擬します。`}>シミュレーター ブラウザ</Header>}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) browse(url);
          }}
        >
          <div className="browser-bar">
            <Input value={url} onChange={(e) => setUrl(e.detail.value)} placeholder="http://web-alb-1234567890.ap-northeast-1.elb.amazonaws.com" ariaLabel="URL" data-testid="browser-url" />
            <Button variant="primary" data-testid="browser-go">移動</Button>
          </div>
        </form>
      </Container>
      {last && <ResultView r={last} />}
    </SpaceBetween>
  );
}
