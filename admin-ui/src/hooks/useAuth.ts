import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, HttpError } from "../api";

interface MeResponse {
  authenticated: boolean;
  exp: number;
}

export interface AuthState {
  /** False until the initial /me probe completes. */
  checked: boolean;
  authenticated: boolean;
}

/**
 * Probes /admin/api/me on mount. If 401, navigates to /login and stashes
 * the originally-requested path in `location.state.from` so post-login can
 * deep-link back. Does NOT redirect on network errors — surfaces them as
 * `checked: true, authenticated: false` so the caller can decide.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ checked: false, authenticated: false });
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const ac = new AbortController();
    api<MeResponse>("/me", { signal: ac.signal })
      .then((r) => setState({ checked: true, authenticated: r.authenticated }))
      .catch((err) => {
        if (ac.signal.aborted) return;
        if (err instanceof HttpError && err.status === 401) {
          navigate("/login", { replace: true, state: { from: location.pathname } });
        }
        setState({ checked: true, authenticated: false });
      });
    return () => ac.abort();
    // We intentionally only re-run on path changes that change the /login
    // redirect target — auth status itself isn't path-dependent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return state;
}
