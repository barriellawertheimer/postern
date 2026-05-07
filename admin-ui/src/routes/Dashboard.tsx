import { useEffect, useState } from "react";
import { api } from "../api";
import type { DashboardDTO } from "../types";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function Dashboard() {
  const [data, setData] = useState<DashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api<DashboardDTO>("/dashboard", { signal: ac.signal })
      .then((d) => setData(d))
      .catch((err) => {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "Failed");
      });
    return () => ac.abort();
  }, []);

  if (error !== null) return <p className="error">Failed to load dashboard: {error}</p>;
  if (data === null) return <p aria-busy="true">Loading…</p>;

  const sendsPct = data.cap > 0 ? Math.round((data.sendsToday / data.cap) * 100) : 0;

  return (
    <article>
      <header>
        <h2>Dashboard</h2>
      </header>

      <div className="grid">
        <article>
          <header>Sends today</header>
          <p style={{ fontSize: "1.5rem", margin: 0 }}>
            <strong>{data.sendsToday}</strong> / {data.cap}
            <small style={{ marginLeft: "0.5rem" }}>({sendsPct}%)</small>
          </p>
          <small>Circuit-breaker threshold: {data.breakerThreshold}</small>
          {data.breakerTripped && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              Circuit breaker tripped — SMTP sends are deferred.
            </p>
          )}
        </article>

        <article>
          <header>Visitors</header>
          <p style={{ fontSize: "1.5rem", margin: 0 }}>
            <strong>{data.visitorsActive}</strong> active
          </p>
          <small>{data.visitorsBlocked} blocked</small>
        </article>
      </div>

      <h3>Failures (last 24h)</h3>
      {data.failures24h.length === 0 ? (
        <p>None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Count</th>
              <th>Most recent</th>
            </tr>
          </thead>
          <tbody>
            {data.failures24h.map((f) => (
              <tr key={f.event}>
                <td>
                  <code>{f.event}</code>
                </td>
                <td>{f.count}</td>
                <td>{fmtTime(f.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
