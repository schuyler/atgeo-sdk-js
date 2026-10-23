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
    let callerAborted = false;
    let abandon: ReturnType<typeof setTimeout> | undefined;
    let expire!: (error: unknown) => void;
    const expired = new Promise<never>((_, reject) => (expire = reject));
    expired.catch(() => {});
    let giveUp!: (error: unknown) => void;
    const abandoned = new Promise<never>((_, reject) => (giveUp = reject));
    abandoned.catch(() => {});
    // Rejects when the request is over, for the wait for headers and for the body.
    const stop = Promise.race([expired, abandoned]);
    stop.catch(() => {});
    const onCallerAbort = () => {
      callerAborted = !timedOut;
      controller.abort(signal?.reason);
      // A fetch that honours the signal rejects by itself, and a response already in hand is read
      // (see readText). One that is still not back a turn later is given up on, so that a fetch
      // which ignores its signal does not outlast the caller's abort.
      if (callerAborted) abandon = setTimeout(() => giveUp(signal?.reason), 0);
    };
    if (signal?.aborted) onCallerAbort();
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
      // Either ends the wait for headers if a custom fetch ignores its signal.
      const response = await Promise.race([pending, stop]);
      if (timedOut) throw controller.signal.reason;
      const text = await readText(response, this.maxBodyBytes, stop);
      return { ok: response.ok, status: response.status, text };
    } catch (error) {
      // A response that arrives after the request was given up on is nobody's; let go of its connection.
      if (timedOut || callerAborted) void pending?.then(discard, () => {});
      // A fetch that ignores the abort reason may reject with a generic AbortError; the caller
      // must not take a timeout for its own cancellation, nor a cancellation for a timeout.
      if (callerAborted) throw signal?.reason;
      if (timedOut && !callerAborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(abandon);
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
// maxBodyBytes decoded bytes (what response.body yields, after any gzip) have arrived. `stop` is a
// promise that rejects when the request is over (its timeout, or the turn after the caller's abort);
// the read is raced against it, so a body that stalls and ignores the abort signal still ends, and
// is cancelled. A body that finishes before `stop` rejects is read even if the caller has already
// aborted: what is in hand surfaces its own failure (an unparsable body, say), as in the contract
// (section 4.4), and a fetch that was honouring the signal would have rejected already.
async function readText(response: Response, maxBodyBytes: number, stop: Promise<never>): Promise<string> {
  if (!response.body) {
    // No stream: a body that is genuinely empty (null on a standard Response), or a fetch that
    // cannot stream. Read what there is whole; the cap is then checked after the fact, which still
    // keeps an oversize body from reaching the caller but cannot save the memory it took.
    const read = response.arrayBuffer();
    read.catch(() => {});
    let bytes: ArrayBuffer;
    try {
      bytes = await Promise.race([read, stop]);
    } catch (error) {
      discard(response);
      throw error;
    }
    if (bytes.byteLength > maxBodyBytes) throw new BodyTooLargeError(maxBodyBytes);
    return new TextDecoder().decode(bytes);
  }
  const reader = response.body.getReader();
  // Same decoding as response.text(): UTF-8, a leading BOM dropped, bad bytes replaced; stream mode
  // carries a character split across two chunks into the next call.
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  // One reaction on `stop` for the whole body, not one per chunk: a race against a promise that stays
  // pending for the life of the request would keep every chunk's race alive until it settled.
  let stopped = false;
  let stopError: unknown;
  let rejectRead: ((error: unknown) => void) | undefined;
  stop.catch((error) => {
    stopped = true;
    stopError = error;
    rejectRead?.(error);
  });
  const readOne = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      if (stopped) return reject(stopError);
      rejectRead = reject;
      reader.read().then(resolve, reject);
    }).finally(() => {
      rejectRead = undefined;
    });
  try {
    for (;;) {
      const { done, value } = await readOne();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) throw new BodyTooLargeError(maxBodyBytes);
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    // Whatever ended the read, the stream is not wanted: cancel it, which also settles a read that
    // is still pending, so the lock can be released.
    try {
      void Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
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
