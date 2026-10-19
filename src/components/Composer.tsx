import { useEffect, useRef, useState } from 'react';

interface ComposerProps {
  open: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onClose: () => void;
}

export function Composer({ open, busy, onSend, onStop, onClose }: ComposerProps) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => ref.current?.focus(), 40);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue('');
    onSend(text);
  };

  return (
    <div className="composer" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={value}
        placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            onClose();
          }
        }}
      />
      {busy ? (
        <button className="send-btn stop" onClick={onStop}>
          停
        </button>
      ) : (
        <button className="send-btn" onClick={submit} disabled={!value.trim()}>
          发送
        </button>
      )}
    </div>
  );
}
