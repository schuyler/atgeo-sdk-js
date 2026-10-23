import { isObject } from "./wire.js";

export class AtgeoError extends Error {
  readonly code: string;
  // The HTTP status, so that a caller can tell a refused request (4xx) from a server failure (5xx)
  // without matching on code, which is an open list.
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AtgeoError";
    this.code = code;
    this.status = status;
  }
}

export class Transport {
  private readonly base: string;

  constructor(
    server: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.base = server.replace(/\/+$/, "");
  }

  // The parsed body, unchecked: the caller reads it with one of the readers in wire.ts.
  async xrpc(nsid: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    return JSON.parse(await this.get(`${this.base}/xrpc/${nsid}?${query}`, signal));
  }

  // Fetches a URL exactly as given and returns the body text; non-2xx raises AtgeoError.
  async get(url: string, signal?: AbortSignal): Promise<string> {
    return checkStatus(await this.fetch(url, signal));
  }

  // Fetches a URL exactly as given and reads the whole body, whatever the status.
  // Anything this throws came from fetch or the body read, never from a status check.
  async fetch(url: string, signal?: AbortSignal): Promise<HttpResponse> {
    const response = await this.fetchImpl(url, { signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  }
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

// Returns the body of a 2xx; raises AtgeoError for anything else.
export function checkStatus({ ok, status, text }: HttpResponse): string {
  if (!ok) {
    // Each field is judged on its own, and a body that is not a JSON object has neither.
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {}
    const fields = isObject(body) ? body : {};
    throw new AtgeoError(
      typeof fields.error === "string" ? fields.error : "HttpError",
      typeof fields.message === "string" ? fields.message : `HTTP ${status}`,
      status,
    );
  }
  return text;
}

export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
