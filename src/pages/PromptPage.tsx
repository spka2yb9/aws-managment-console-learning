import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import Header from '@cloudscape-design/components/header';
import prompt from '../prompt/prompt.md?raw';
import { AppShell } from '../app/AppShell';

export function PromptPage() {
  return (
    <AppShell active="/prompt">
      <ContentLayout header={<Header variant="h1" description="このアプリの開発指示Prompt全文です。">Prompt</Header>}>
        <Container
          header={
            <Header actions={<CopyToClipboard variant="button" textToCopy={prompt} copyButtonText="Copy Prompt" copySuccessText="Copied" copyErrorText="Copy failed" />}>
              開発指示Prompt
            </Header>
          }
        >
          <pre className="prompt-text" data-testid="prompt-text">{prompt}</pre>
        </Container>
      </ContentLayout>
    </AppShell>
  );
}
