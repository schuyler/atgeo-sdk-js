export class AtgeoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AtgeoError";
    this.code = code;
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

  async xrpc<T>(nsid: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const query = new URLSearchParams(params).toString();
    return JSON.parse(await this.get(`${this.base}/xrpc/${nsid}?${query}`, signal)) as T;
  }

  // Fetches a URL exactly as given and returns the body text; non-2xx raises AtgeoError.
  async get(url: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(url, { signal });
    const text = await response.text();
    if (!response.ok) {
      let body: { error?: string; message?: string } = {};
      try {
        body = JSON.parse(text);
      } catch {}
      throw new AtgeoError(body.error ?? "HttpError", body.message ?? `HTTP ${response.status}`);
    }
    return text;
  }
}

export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
