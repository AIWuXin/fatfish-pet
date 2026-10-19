import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import QRCode from 'qrcode';

interface BiliLoginProps {
  onClose: () => void;
  onLoggedIn: () => void;
}

interface QrData {
  qrcodeKey: string;
  url: string;
}

type Phase = 'idle' | 'loading' | 'waiting' | 'scanned' | 'success' | 'expired' | 'error';

export function BiliLogin({ onClose, onLoggedIn }: BiliLoginProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [note, setNote] = useState<string>('');
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = useCallback(async () => {
    clearTimer();
    setPhase('loading');
    setNote('');
    try {
      const data = await invoke<QrData>('bili_login_qr');
      const img = await QRCode.toDataURL(data.url, {
        width: 200,
        margin: 1,
        color: { dark: '#2a3550', light: '#ffffff' },
      });
      setQrImage(img);
      setPhase('waiting');

      timerRef.current = window.setInterval(async () => {
        try {
          const res = await invoke<{ status: string }>('bili_login_poll', { qrcodeKey: data.qrcodeKey });
          if (res.status === 'scanned') {
            setPhase('scanned');
            setNote('已扫码，请在手机上确认');
          } else if (res.status === 'success') {
            clearTimer();
            setPhase('success');
            setNote('登录成功');
            window.setTimeout(onLoggedIn, 900);
          } else if (res.status === 'expired') {
            clearTimer();
            setPhase('expired');
            setNote('二维码过期了，重新生成一个');
          }
        } catch {
          /* 单次轮询失败继续 */
        }
      }, 2000);
    } catch (err) {
      setPhase('error');
      setNote(err instanceof Error ? err.message : String(err));
    }
  }, [onLoggedIn]);

  useEffect(() => {
    void start();
    return clearTimer;
  }, [start]);

  return (
    <div
      className="settings bili-login"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="settings-head">
        <span>登录 B 站</span>
        <button className="icon-btn" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      <div className="qr-holder">
        {qrImage && phase !== 'success' ? (
          <img src={qrImage} alt="B站登录二维码" className={phase === 'scanned' ? 'qr-dim' : ''} />
        ) : (
          <div className="qr-placeholder">{phase === 'success' ? '✓' : '…'}</div>
        )}
      </div>

      <div className="qr-note">
        {phase === 'loading' && '正在生成二维码…'}
        {phase === 'waiting' && '用 B 站手机客户端扫码'}
        {phase === 'scanned' && '已扫码，手机上点确认'}
        {phase === 'success' && '好了，她可以自己去评论了'}
        {phase === 'expired' && note}
        {phase === 'error' && `出错了：${note}`}
      </div>

      {(phase === 'expired' || phase === 'error') && (
        <button className="primary-btn" onClick={() => void start()}>
          重新生成
        </button>
      )}

      <div className="qr-foot">
        扫码只用来发评论和读取你的 B 站推荐。凭证存在本机，随时可以在设置里退出。
      </div>
    </div>
  );
}
