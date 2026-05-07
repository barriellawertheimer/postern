import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { SubmissionDTO } from "../types";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function Submission() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [submission, setSubmission] = useState<SubmissionDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) {
      setError("Invalid submission id");
      return;
    }
    const ac = new AbortController();
    setSubmission(null);
    setError(null);
    api<{ submission: SubmissionDTO }>(`/submissions/${id}`, { signal: ac.signal })
      .then((r) => setSubmission(r.submission))
      .catch((err) => {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "Failed");
      });
    return () => ac.abort();
  }, [id]);

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
  if (submission === null) return <p aria-busy="true">Loading…</p>;

  return (
    <article>
      <header>
        <p style={{ marginBottom: "0.5rem" }}>
          <Link to={`/visitors/${submission.visitorId}`}>← Back to visitor</Link>
        </p>
        <h2>Submission #{submission.id}</h2>
      </header>

      <dl>
        <dt>Received</dt>
        <dd>{fmtTime(submission.createdAt)}</dd>
        {submission.ipHashHex !== null && (
          <>
            <dt>IP hash</dt>
            <dd>
              <code style={{ wordBreak: "break-all" }}>{submission.ipHashHex}</code>
            </dd>
          </>
        )}
        {submission.uaHashHex !== null && (
          <>
            <dt>User-Agent hash</dt>
            <dd>
              <code style={{ wordBreak: "break-all" }}>{submission.uaHashHex}</code>
            </dd>
          </>
        )}
      </dl>

      <h3>Message</h3>
      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{submission.message}</pre>
    </article>
  );
}
