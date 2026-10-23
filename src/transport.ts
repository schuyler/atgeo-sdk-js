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

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// The longest delay setTimeout honours; a larger one fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TransportLimits {
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}

// Thrown when a response body, once decoded, is larger than maxBodyBytes. A tile that raises it is a
// failed tile of kind "transport".
export class BodyTooLargeError extends Error {
  readonly maxBodyBytes: number;

  constructor(maxBodyBytes: number) {
    super(`response body is larger than maxBodyBytes (${maxBodyBytes} bytes)`);
    this.name = "BodyTooLargeError";
    this.maxBodyBytes = maxBodyBytes;
  }
}

export class Transport {
  private readonly base: string;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(
    server: string,
    private readonly fetchImpl: typeof fetch,
    limits: TransportLimits = {},
  ) {
    this.base = server.replace(/\/+$/, "");
    this.maxBodyBytes = limits.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.requestTimeoutMs = limits.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0) {
      throw new TypeError("maxBodyBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > MAX_TIMER_MS) {
      throw new TypeError(`requestTimeoutMs must be a positive integer no larger than ${MAX_TIMER_MS}`);
    }
  }

  async xrpc<T>(nsid: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const query = new URLSearchParams(params).toString();
    return JSON.parse(await this.get(`${this.base}/xrpc/${nsid}?${query}`, signal)) as T;
  }

  // Fetches a URL exactly as given and returns the body text; non-2xx raises AtgeoError.
  async get(url: string, signal?: AbortSignal): Promise<string> {
    return checkStatus(await this.fetch(url, signal));
  }

  // Fetches a URL exactly as given and reads the whole body, whatever the status.
  // Anything this throws came from fetch or the body read, never from a status check.
  //
  // The request has requestTimeoutMs from the call to the last byte of the body. The caller's signal
  // and the timeout are folded into one signal by hand rather than with AbortSignal.any and
  // AbortSignal.timeout: Node 20.0 to 20.2 has no any(), and this way the timer and the listener on
  // the caller's signal are released when the request ends, so a long-lived signal shared by many
  // requests does not accumulate them. A caller's abort surfaces as the caller's own reason, as
  // before; a timeout surfaces as a DOMException named "TimeoutError", which is what
  // AbortSignal.timeout() raises.
  async fetch(url: string, signal?: AbortSignal): Promise<HttpResponse> {
    const controller = new AbortController();
    let timedOut = false;
    let expire!: (error: unknown) => void;
    const expired = new Promise<never>((_, reject) => (expire = reject));
    expired.catch(() => {});
    const onCallerAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      const error = new DOMException(`request timed out after ${this.requestTimeoutMs} ms`, "TimeoutError");
      controller.abort(error);
      expire(error);
    }, this.requestTimeoutMs);
    let pending: Promise<Response> | undefined;
    try {
      pending = Promise.resolve(this.fetchImpl(url, { signal: controller.signal }));
      // The timeout also ends the wait for headers if a custom fetch ignores its signal. The
      // caller's own abort does not: that takes effect through the request, as it always has.
      const response = await Promise.race([pending, expired]);
      if (timedOut) throw controller.signal.reason;
      const text = await readText(response, this.maxBodyBytes, controller.signal);
      return { ok: response.ok, status: response.status, text };
    } catch (error) {
      // A response that arrives after the timeout is nobody's; let go of its connection.
      if (timedOut) void pending?.then(discard, () => {});
      // A fetch that ignores the abort reason may reject with a generic AbortError; the caller
      // must not take a timeout for its own cancellation.
      if (timedOut && !signal?.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {}
}

// Reads a response body as UTF-8 text, failing with BodyTooLargeError as soon as more than
// maxBodyBytes decoded bytes (what response.body yields, after any gzip) have arrived, and with the
// signal's reason if it aborts first, even when the stream itself is not tied to the signal.
async function readText(response: Response, maxBodyBytes: number, signal: AbortSignal): Promise<string> {
  // Only an abort that comes during the read ends it. A signal already aborted when the response
  // arrived is the caller's, and a fetch that was honouring it would have rejected: what is in hand
  // is still read, so that the tile's own failure (an unparsable body, say) is what surfaces, as in
  // the contract (section 4.4).
  if (!response.body) {
    // No stream: a body that is genuinely empty (null on a standard Response), or a fetch that
    // cannot stream. Read what there is whole; the cap is then checked after the fact, which still
    // keeps an oversize body from reaching the caller but cannot save the memory it took.
    const bytes = await abortable(response.arrayBuffer(), signal);
    if (bytes.byteLength > maxBodyBytes) throw new BodyTooLargeError(maxBodyBytes);
    return new TextDecoder().decode(bytes);
  }
  const reader = response.body.getReader();
  // Cancelling a reader with a read pending settles that read as done, not as an error, so the
  // loop below checks this flag after every read.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Same decoding as response.text(): UTF-8, a leading BOM dropped, bad bytes replaced; stream mode
  // carries a character split across two chunks into the next call.
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBodyBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

// Settles with promise, or rejects with the signal's reason if it aborts first.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

// Returns the body of a 2xx; raises AtgeoError for anything else.
export function checkStatus({ ok, status, text }: HttpResponse): string {
  if (!ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {}
    throw new AtgeoError(body.error ?? "HttpError", body.message ?? `HTTP ${status}`, status);
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
