import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { PagedResponse, VisitorDTO, VisitorStatus } from "../types";

const PAGE_SIZE = 50;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function Visitors() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<PagedResponse<VisitorDTO> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const status = (params.get("status") as VisitorStatus | "" | null) ?? "";
  const q = params.get("q") ?? "";
  const offset = Math.max(0, Number(params.get("offset") ?? "0") || 0);

  useEffect(() => {
    const ac = new AbortController();
    const u = new URLSearchParams();
    u.set("limit", String(PAGE_SIZE));
    u.set("offset", String(offset));
    if (status) u.set("status", status);
    if (q) u.set("q", q);
    setData(null);
    setError(null);
    api<PagedResponse<VisitorDTO>>(`/visitors?${u.toString()}`, { signal: ac.signal })
      .then((d) => setData(d))
      .catch((err) => {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "Failed");
      });
    return () => ac.abort();
  }, [status, q, offset]);

  function update(next: { status?: string; q?: string; offset?: number }): void {
    const merged = new URLSearchParams(params);
    if (next.status !== undefined) {
      if (next.status) merged.set("status", next.status);
      else merged.delete("status");
      merged.delete("offset");
    }
    if (next.q !== undefined) {
      if (next.q) merged.set("q", next.q);
      else merged.delete("q");
      merged.delete("offset");
    }
    if (next.offset !== undefined) merged.set("offset", String(next.offset));
    setParams(merged);
  }

  function onSearchSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    update({ q: searchInputRef.current?.value.trim() ?? "" });
  }

  const onPrev = (): void => update({ offset: Math.max(0, offset - PAGE_SIZE) });
  const onNext = (): void => update({ offset: offset + PAGE_SIZE });

  return (
    <article>
      <header>
        <h2>Visitors{data ? ` (${data.total})` : ""}</h2>
      </header>

      <form onSubmit={onSearchSubmit} role="search" style={{ display: "flex", gap: "0.5rem" }}>
        <input
          ref={searchInputRef}
          name="q"
          type="search"
          placeholder="Email or alias substring"
          defaultValue={q}
        />
        <button type="submit" className="secondary">
          Search
        </button>
        {q && (
          <button
            type="button"
            className="secondary outline"
            onClick={() => {
              if (searchInputRef.current) searchInputRef.current.value = "";
              update({ q: "" });
            }}
          >
            Clear
          </button>
        )}
      </form>

      <fieldset role="group" style={{ display: "flex", gap: "1rem", marginBlock: "0.5rem" }}>
        <label>
          <input
            type="radio"
            name="status"
            checked={status === ""}
            onChange={() => update({ status: "" })}
          />
          All
        </label>
        <label>
          <input
            type="radio"
            name="status"
            checked={status === "active"}
            onChange={() => update({ status: "active" })}
          />
          Active
        </label>
        <label>
          <input
            type="radio"
            name="status"
            checked={status === "blocked"}
            onChange={() => update({ status: "blocked" })}
          />
          Blocked
        </label>
      </fieldset>

      {error !== null && <p className="error">Failed to load visitors: {error}</p>}
      {data === null && error === null && <p aria-busy="true">Loading…</p>}

      {data !== null && (
        <>
          {data.rows.length === 0 ? (
            <p>No visitors match.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Alias</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link to={`/visitors/${v.id}`}>
                        <code>{v.aliasFull}</code>
                      </Link>
                    </td>
                    <td>
                      {v.firstName} {v.lastName} &lt;{v.email}&gt;
                    </td>
                    <td>
                      <span className={`status-pill ${v.status}`}>{v.status}</span>
                    </td>
                    <td>{fmtTime(v.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {q === "" && data.total > PAGE_SIZE && (
            <nav style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button type="button" className="secondary" disabled={offset === 0} onClick={onPrev}>
                Previous
              </button>
              <small style={{ alignSelf: "center" }}>
                {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
              </small>
              <button
                type="button"
                className="secondary"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={onNext}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </article>
  );
}
