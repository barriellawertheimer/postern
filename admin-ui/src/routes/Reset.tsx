import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, HttpError } from "../api";

const MIN_LEN = 8;

export function Reset() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (password.length < MIN_LEN) {
      setError(`Password must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await api("/reset", { method: "POST", body: { token, password } });
      setDone(true);
      setTimeout(() => navigate("/login", { replace: true }), 2000);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        setError("This reset link is no longer valid. Request a new one.");
      } else if (err instanceof HttpError && err.status === 429) {
        setError("Too many attempts. Try again later.");
      } else if (err instanceof HttpError && err.status === 400) {
        setError("Invalid input. Check the password and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Reset failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (token.length === 0) {
    return (
      <main className="container" style={{ maxWidth: "22rem", marginTop: "4rem" }}>
        <h1>Reset password</h1>
        <p className="error">Missing reset token. Use the link from your email.</p>
        <p>
          <Link to="/forgot">Request a new reset link</Link>
        </p>
      </main>
    );
  }

  if (done) {
    return (
      <main className="container" style={{ maxWidth: "22rem", marginTop: "4rem" }}>
        <h1>Password updated</h1>
        <p>Redirecting to sign in…</p>
      </main>
    );
  }

  return (
    <main className="container" style={{ maxWidth: "22rem", marginTop: "4rem" }}>
      <h1>Choose a new password</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            minLength={MIN_LEN}
            autoComplete="new-password"
          />
        </label>
        <label>
          Confirm
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={MIN_LEN}
            autoComplete="new-password"
          />
        </label>
        {error !== null && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting || password.length < MIN_LEN}>
          {submitting ? "Updating…" : "Update password"}
        </button>
      </form>
    </main>
  );
}
