import { useEffect, useRef, useState } from 'react';
import type { LoginState, LoginTarget } from '../../../shared/accounts';
import { useI18n } from '../i18n';
import { closeModal } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { IX } from './icons';
import { RefreshIcon } from './Spinner';

const CLOSE_AFTER_SUCCESS_MS = 1200;

/** Sign-in window: runs the provider's login command in an embedded terminal and follows the main process' progress. */
export function AuthModal({ provider, target }: { provider: 'claude' | 'codex'; target: LoginTarget }) {
  const { tr } = useI18n();
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  // The latest state may arrive before startLogin resolves, so it is matched to the session at render time.
  const [state, setState] = useState<LoginState | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const session = useRef<string | null>(null);
  const pty = useRef<string | null>(null);

  useEffect(() => {
    cancelled.current = false;
    const off = window.mc.on('auth:state', (s) => setState(s));
    void window.mc.startLogin({ provider, target }).then((res) => {
      if (!res.ok) {
        if (!cancelled.current) setStartFailed(true);
        return;
      }
      if (cancelled.current) {
        // Closed before the session was created: cancel it as soon as it exists.
        window.mc.cancelLogin(res.sessionId);
        return;
      }
      session.current = res.sessionId;
      pty.current = res.ptyId;
      terminals.ensure(res.ptyId, { fontSize: 13, agent: false });
      setSessionId(res.sessionId);
      setPtyId(res.ptyId);
    }).catch(() => {
      if (!cancelled.current) setStartFailed(true);
    });
    return () => {
      cancelled.current = true;
      off();
      if (session.current) window.mc.cancelLogin(session.current); // harmless after success
      if (pty.current) terminals.dispose(pty.current);
    };
  }, [provider, target]);

  useEffect(() => {
    const el = container.current;
    if (!ptyId || !el) return;
    terminals.attach(ptyId, el);
    terminals.focus(ptyId);
    return () => terminals.detach(ptyId, el);
  }, [ptyId]);

  const current = state && state.sessionId === sessionId ? state : null;
  const status = startFailed ? 'failed' : current?.status ?? 'waiting';

  useEffect(() => {
    if (status !== 'success') return;
    const timer = setTimeout(closeModal, CLOSE_AFTER_SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const title = provider === 'codex'
    ? tr('Zaloguj się do Codex')
    : target.type === 'new' ? tr('Dodaj konto Claude') : tr('Zaloguj ponownie do Claude');
  const email = current?.email ?? '';
  const waiting = status === 'waiting';

  let line: string;
  if (status === 'success') line = email ? tr('Zalogowano jako {email}', { email }) : tr('Zalogowano.');
  else if (status === 'duplicate') line = tr('To konto jest już dodane ({email}).', { email });
  else if (status === 'failed') {
    line = current?.error === 'timeout' ? tr('Upłynął czas na logowanie.')
      : current?.error === 'identity' ? tr('Nie udało się odczytać konta po zalogowaniu.')
        : tr('Logowanie nie powiodło się.');
  } else line = tr('Czekam na logowanie…');

  return (
    <div className="modal auth">
      <div className="modal-head">
        <h3>{title}</h3>
        <button className="btn ghost icon" onClick={closeModal} aria-label={tr('Zamknij')}><IX /></button>
      </div>
      <div className="auth-note muted">{tr('Dokończ logowanie w przeglądarce. Okno zamknie się samo, gdy logowanie się powiedzie.')}</div>
      <div className="auth-terminal" ref={container} />
      <div className={`auth-status ${waiting ? 'wait' : status === 'success' ? 'ok' : 'bad'}`}>
        {waiting && <RefreshIcon spinning />}
        <span>{line}</span>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>{waiting ? tr('Anuluj') : tr('Zamknij')}</button>
      </div>
    </div>
  );
}
