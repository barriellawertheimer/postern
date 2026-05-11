import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, HttpError } from "../api";

export function Forgot() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api("/forgot", { method: "POST", body: { email } });
      // The backend always 204s — `sent` here means "request accepted",
      // not "we found a matching admin email". That's intentional.
      setSent(true);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        setError("Too many attempts. Try again later.");
      } else {
        setError(err instanceof Error ? err.message : "Request failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <main className="container" style={{ maxWidth: "22rem", marginTop: "4rem" }}>
        <h1>Check your email</h1>
        <p>
          If <code>{email}</code> matches the admin mailbox, a reset link has
          been sent. The link is valid for 15 minutes and can only be used once.
        </p>
        <p>
          <Link to="/login">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="container" style={{ maxWidth: "22rem", marginTop: "4rem" }}>
      <h1>Reset password</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label>
          Admin email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            autoComplete="email"
          />
        </label>
        {error !== null && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting || email.length === 0}>
          {submitting ? "Sending…" : "Email me a reset link"}
        </button>
      </form>
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </main>
  );
}
