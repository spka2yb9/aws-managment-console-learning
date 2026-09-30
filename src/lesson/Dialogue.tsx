import Avatar from '@cloudscape-design/chat-components/avatar';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { Fragment, type ReactNode } from 'react';
import type { DialogueLine, Speaker } from './types';

// public/ assets: BASE_URL keeps them working under any GitHub Pages subpath
export const SPEAKERS: Record<Speaker, { name: string; icon: string }> = {
  hakase: { name: 'パス博士', icon: `${import.meta.env.BASE_URL}chat_icon_professor.svg` },
  node: { name: 'ノード君', icon: `${import.meta.env.BASE_URL}chat_icon_young.svg` },
};

/** `code` spans and **bold** inside dialogue text. */
export function richText(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('`') ? <code key={i} className="inline-code">{part.slice(1, -1)}</code> : part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>,
  );
}

/** パス博士 speaks from the left, ノード君 from the right. */
export function Dialogue({ lines }: { lines: DialogueLine[] }) {
  return (
    <SpaceBetween size="s">
      {lines.map((l, i) => {
        const who = SPEAKERS[l.speaker];
        const hideAvatar = i > 0 && lines[i - 1].speaker === l.speaker;
        return (
          <div key={i} className={`dialogue-line dialogue-${l.speaker}`} data-speaker={l.speaker}>
            <ChatBubble
              type={l.speaker === 'hakase' ? 'incoming' : 'outgoing'}
              align={l.speaker === 'hakase' ? 'start' : 'end'}
              ariaLabel={`${who.name}: ${l.text}`}
              hideAvatar={hideAvatar}
              style={l.speaker === 'node' ? { bubble: { background: 'rgba(0, 108, 224, 0.10)', borderRadius: '12px' } } : undefined}
              avatar={<Avatar ariaLabel={who.name} tooltipText={who.name} imgUrl={who.icon} width={36} />}
            >
              {!hideAvatar && <Box variant="small" fontWeight="bold" color="text-body-secondary">{who.name}</Box>}
              <div className="dialogue-text">{richText(l.text)}</div>
            </ChatBubble>
          </div>
        );
      })}
    </SpaceBetween>
  );
}
