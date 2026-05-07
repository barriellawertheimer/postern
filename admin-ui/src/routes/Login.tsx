import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, HttpError } from "../api";

export function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api("/login", { method: "POST", body: { password } });
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        setError("Wrong password.");
      } else if (err instanceof HttpError && err.status === 429) {
        setError("Too many attempts. Try again later.");
      } else {
        setError(err instanceof Error ? err.message : "Login failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: "22rem", marginTop: "4rem" }}>
      <h1>Postern admin</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            autoComplete="current-password"
          />
        </label>
        {error !== null && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting || password.length === 0}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
