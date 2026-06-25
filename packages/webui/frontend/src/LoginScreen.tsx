import { useState } from 'react';

interface Props {
  onLogin(password: string): Promise<void>;
}

/** Skinned to match the design system in design.css — surface/border/accent
 *  tokens replace the previous inline whites/blues. */
export default function LoginScreen({ onLogin }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <form onSubmit={submit} className="login-card">
        <div className="login-brand">
          <div className="login-mark">Q</div>
          <div>
            <div className="login-title">QanYiCat WebUI</div>
            <div className="login-sub" style={{ marginTop: 2 }}>登录以管理协议端</div>
          </div>
        </div>
        <input
          type="password"
          className="login-input"
          placeholder="webui password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <div className="login-error">{error}</div> : null}
        <button type="submit" disabled={submitting || password.length === 0} className="btn primary login-submit">
          {submitting ? '…' : '登录'}
        </button>
      </form>
    </main>
  );
}
