import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient } from './api';
import LoginScreen from './LoginScreen';
import Dashboard from './Dashboard';

export default function App() {
  const api = useMemo(() => createApiClient(), []);
  const [authed, setAuthed] = useState<boolean>(Boolean(api.token));

  // Probe an authed endpoint at mount — handles stale-token-on-disk cases.
  useEffect(() => {
    if (!authed) return;
    api.instance().catch(() => setAuthed(false));
  }, [api, authed]);

  const onLogin = useCallback(async (password: string) => {
    await api.login(password);
    setAuthed(true);
  }, [api]);

  const onLogout = useCallback(() => {
    api.logout();
    setAuthed(false);
  }, [api]);

  if (!authed) return <LoginScreen onLogin={onLogin} />;
  return <Dashboard api={api} onLogout={onLogout} />;
}
