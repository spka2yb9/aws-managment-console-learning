import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { CliShell } from '../shell/shell';
import { TerminalController } from './TerminalController';

interface Props {
  shell: CliShell;
  /* レッスン側がリセットや「ターミナルに入力」に使う */
  onReady: (controller: TerminalController) => void;
}

export function Terminal({ shell, onReady }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const c = new TerminalController(el.current!, shell, (msg) => {
      setNote(msg);
      clearTimeout(timer);
      timer = setTimeout(() => setNote(''), 1600);
    });
    onReady(c);
    return () => {
      clearTimeout(timer);
      c.dispose();
    };
  }, [shell, onReady]);

  return (
    <div className="xterm-box" data-testid="cli-terminal">
      <div className="xterm-head">
        <span>Terminal — learner@my-pc</span>
        <span className="xterm-note">{note || 'ブラウザ内の仮想シェルです。実際の AWS には接続しません'}</span>
      </div>
      <div className="xterm-body" ref={el} />
    </div>
  );
}
