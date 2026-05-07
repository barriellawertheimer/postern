// Thin fetch wrapper for /admin/api/*. Sends cookies, expects JSON, and
// surfaces non-2xx responses as `HttpError` instances so the UI can react
// to specific statuses (most importantly, 401 → redirect to /login).

const API_BASE = "/admin/api";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  let bodyInit: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    bodyInit = JSON.stringify(opts.body);
  } else if (opts.method && opts.method !== "GET" && opts.method !== "HEAD") {
    // Mutating endpoints require content-type even with an empty body — the
    // backend's CSRF guard rejects requests that don't claim application/json.
    headers.set("content-type", "application/json");
  }

  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
    credentials: "same-origin",
  };
  if (bodyInit !== undefined) init.body = bodyInit;
  if (opts.signal !== undefined) init.signal = opts.signal;

  const res = await fetch(`${API_BASE}${path}`, init);

  let data: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : `HTTP ${res.status}`;
    throw new HttpError(res.status, msg);
  }
  return data as T;
}
