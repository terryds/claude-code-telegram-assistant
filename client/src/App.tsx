import { useEffect, useState } from 'react';
import { Router, Route, Switch, Redirect } from 'wouter';
import { api, type Status } from './api';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Capabilities } from './pages/Capabilities';
import { Memories } from './pages/Memories';

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (error) {
    return (
      <div className="min-h-full flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold text-red-400">Server unreachable</h1>
          <p className="text-zinc-400 text-sm">{error}</p>
          <button
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm"
            onClick={refresh}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="min-h-full flex items-center justify-center text-zinc-500">
        Loading…
      </div>
    );
  }

  return (
    <Router>
      <Switch>
        <Route path="/onboarding">
          <Onboarding status={status} onChange={refresh} />
        </Route>
        <Route path="/">
          {status.onboarded ? (
            <Dashboard status={status} onChange={refresh} />
          ) : (
            <Redirect to="/onboarding" />
          )}
        </Route>
        <Route path="/capabilities">
          {status.onboarded ? <Capabilities /> : <Redirect to="/onboarding" />}
        </Route>
        <Route path="/memories">
          {status.onboarded ? <Memories /> : <Redirect to="/onboarding" />}
        </Route>
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </Router>
  );
}
