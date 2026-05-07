import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { AuditEntryDTO, PagedResponse } from "../types";

const PAGE_SIZE = 50;

interface SinceOption {
  value: string;
  label: string;
  ms: number;
}

const SINCE_OPTIONS: SinceOption[] = [
  { value: "", label: "All time", ms: 0 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];
const DEFAULT_SINCE: SinceOption = { value: "", label: "All time", ms: 0 };

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function AuditLog() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<PagedResponse<AuditEntryDTO> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eventInputRef = useRef<HTMLInputElement | null>(null);

  const event = params.get("event") ?? "";
  const sinceKey = params.get("since") ?? "";
  const offset = Math.max(0, Number(params.get("offset") ?? "0") || 0);
  const sinceOption = SINCE_OPTIONS.find((o) => o.value === sinceKey) ?? DEFAULT_SINCE;

  useEffect(() => {
    const ac = new AbortController();
    const u = new URLSearchParams();
    u.set("limit", String(PAGE_SIZE));
    u.set("offset", String(offset));
    if (event) u.set("event", event);
    if (sinceOption.ms > 0) u.set("since", String(Date.now() - sinceOption.ms));
    setData(null);
    setError(null);
    api<PagedResponse<AuditEntryDTO>>(`/audit?${u.toString()}`, { signal: ac.signal })
      .then((d) => setData(d))
      .catch((err) => {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "Failed");
      });
    return () => ac.abort();
  }, [event, sinceKey, sinceOption.ms, offset]);

  function update(next: { event?: string; since?: string; offset?: number }): void {
    const merged = new URLSearchParams(params);
    if (next.event !== undefined) {
      if (next.event) merged.set("event", next.event);
      else merged.delete("event");
      merged.delete("offset");
    }
    if (next.since !== undefined) {
      if (next.since) merged.set("since", next.since);
      else merged.delete("since");
      merged.delete("offset");
    }
    if (next.offset !== undefined) merged.set("offset", String(next.offset));
    setParams(merged);
  }

  function onEventSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    update({ event: eventInputRef.current?.value.trim() ?? "" });
  }

  return (
    <article>
      <header>
        <h2>Audit log{data !== null ? ` (${data.total})` : ""}</h2>
      </header>

      <form onSubmit={onEventSubmit} role="search" style={{ display: "flex", gap: "0.5rem" }}>
        <input
          ref={eventInputRef}
          name="event"
          type="search"
          placeholder="Event name (e.g. admin_block, smtp_send_failed)"
          defaultValue={event}
        />
        <button type="submit" className="secondary">
          Filter
        </button>
        {event && (
          <button
            type="button"
            className="secondary outline"
            onClick={() => {
              if (eventInputRef.current) eventInputRef.current.value = "";
              update({ event: "" });
            }}
          >
            Clear
          </button>
        )}
      </form>

      <fieldset>
        <label>
          Time range:{" "}
          <select value={sinceKey} onChange={(e) => update({ since: e.target.value })}>
            {SINCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      {error !== null && <p className="error">Failed to load audit log: {error}</p>}
      {data === null && error === null && <p aria-busy="true">Loading…</p>}

      {data !== null &&
        (data.rows.length === 0 ? (
          <p>No matching events.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Visitor</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtTime(r.createdAt)}</td>
                    <td>
                      <code>{r.event}</code>
                    </td>
                    <td>
                      {r.visitorId !== null ? (
                        <Link to={`/visitors/${r.visitorId}`}>#{r.visitorId}</Link>
                      ) : (
                        <small>—</small>
                      )}
                    </td>
                    <td style={{ wordBreak: "break-word" }}>{r.detail ?? <small>—</small>}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {data.total > PAGE_SIZE && (
              <nav style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="secondary"
                  disabled={offset === 0}
                  onClick={() => update({ offset: Math.max(0, offset - PAGE_SIZE) })}
                >
                  Previous
                </button>
                <small style={{ alignSelf: "center" }}>
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
                </small>
                <button
                  type="button"
                  className="secondary"
                  disabled={offset + PAGE_SIZE >= data.total}
                  onClick={() => update({ offset: offset + PAGE_SIZE })}
                >
                  Next
                </button>
              </nav>
            )}
          </>
        ))}
    </article>
  );
}
