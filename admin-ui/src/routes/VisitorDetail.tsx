import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { SubmissionDTO, VisitorDTO, VisitorStatus } from "../types";

interface DetailResponse {
  visitor: VisitorDTO;
  submissions: SubmissionDTO[];
  submissionsTotal: number;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

const PREVIEW_CHARS = 1000;

export function VisitorDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) {
      setError("Invalid visitor id");
      return;
    }
    const ac = new AbortController();
    setData(null);
    setError(null);
    api<DetailResponse>(`/visitors/${id}`, { signal: ac.signal })
      .then((d) => setData(d))
      .catch((err) => {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "Failed");
      });
    return () => ac.abort();
  }, [id]);

  async function toggleStatus(): Promise<void> {
    if (data === null || acting) return;
    const goingTo: VisitorStatus = data.visitor.status === "active" ? "blocked" : "active";
    const action = goingTo === "blocked" ? "block" : "unblock";
    if (
      action === "block" &&
      !window.confirm(
        `Block ${data.visitor.email}?\n\n` +
          "Future submissions from this email will be silently rejected (the contact form returns 202 like a normal queued send).\n" +
          "The SimpleLogin alias keeps routing, so you can still reply to existing threads. Unblock to restore.",
      )
    ) {
      return;
    }
    setActing(true);
    try {
      const res = await api<{ status: VisitorStatus }>(`/visitors/${id}/${action}`, { method: "POST" });
      setData({ ...data, visitor: { ...data.visitor, status: res.status } });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

  if (error !== null) {
    return (
      <article>
        <p className="error">{error}</p>
        <p>
          <Link to="/visitors">← Back to visitors</Link>
        </p>
      </article>
    );
  }
  if (data === null) return <p aria-busy="true">Loading…</p>;

  const v = data.visitor;
  const blocked = v.status === "blocked";

  return (
    <article>
      <header>
        <p style={{ marginBottom: "0.5rem" }}>
          <Link to="/visitors">← Back to visitors</Link>
        </p>
        <h2 style={{ marginBottom: "0.25rem" }}>
          {v.firstName} {v.lastName}{" "}
          <span className={`status-pill ${v.status}`}>{v.status}</span>
        </h2>
        <p>
          <code>{v.aliasFull}</code>
        </p>
      </header>

      <div className="grid">
        <dl>
          <dt>Email</dt>
          <dd>{v.email}</dd>
          <dt>Reverse alias</dt>
          <dd>
            <code>{v.slReverseAlias}</code>
          </dd>
          <dt>SimpleLogin alias id</dt>
          <dd>{v.slAliasId}</dd>
        </dl>
        <dl>
          <dt>First seen</dt>
          <dd>{fmtTime(v.createdAt)}</dd>
          <dt>Last seen</dt>
          <dd>{fmtTime(v.lastSeenAt)}</dd>
          <dt>Submissions</dt>
          <dd>{data.submissionsTotal}</dd>
        </dl>
      </div>

      <button
        type="button"
        className={blocked ? "contrast" : "secondary"}
        onClick={() => void toggleStatus()}
        disabled={acting}
      >
        {acting ? "Working…" : blocked ? "Unblock visitor" : "Block visitor"}
      </button>

      <h3 style={{ marginTop: "2rem" }}>Submissions</h3>
      {data.submissionsTotal > data.submissions.length && (
        <p>
          <small>
            Showing first {data.submissions.length} of {data.submissionsTotal}.
          </small>
        </p>
      )}
      {data.submissions.length === 0 ? (
        <p>None yet.</p>
      ) : (
        data.submissions.map((s) => {
          const truncated = s.message.length > PREVIEW_CHARS;
          const preview = truncated ? `${s.message.slice(0, PREVIEW_CHARS)}…` : s.message;
          return (
            <article key={s.id} style={{ marginBlock: "0.75rem" }}>
              <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <small>{fmtTime(s.createdAt)}</small>
                <Link to={`/submissions/${s.id}`}>
                  {truncated ? "View full ↗" : "View ↗"}
                </Link>
              </header>
              <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>{preview}</pre>
            </article>
          );
        })
      )}
    </article>
  );
}
