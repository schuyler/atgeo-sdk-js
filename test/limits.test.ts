import { afterEach, describe, expect, it, vi } from "vitest";
import { AtgeoClient, BodyTooLargeError } from "../src/index.js";
import { DEFAULT_SERVER, place, point, record } from "./helpers/fakeServer.js";

const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const TILE = "https://tiles.example/a.json";
const encoder = new TextEncoder();

// A tile body of exactly `bytes` bytes: valid JSON, padded with spaces after the document.
function tileOfSize(bytes: number, name = "A"): Uint8Array<ArrayBuffer> {
  const doc = encoder.encode(JSON.stringify({ records: [record(place("a", name, [point(37.772, -122.412)]))] }));
  if (doc.byteLength > bytes) throw new Error("size too small for the document");
  const out = new Uint8Array(new ArrayBuffer(bytes)).fill(0x20);
  out.set(doc);
  return out;
}

// A fetch that answers getTiles with [TILE] and the tile URL with whatever `tile` makes.
function tileFetch(tile: (init: RequestInit | undefined) => Response | Promise<Response>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input).url;
    if (url.startsWith(`${DEFAULT_SERVER}/xrpc/org.atgeo.getTiles`)) return new Response(JSON.stringify({ tiles: [TILE] }));
    return tile(init);
  }) as typeof fetch;
}

// A body of `chunks` chunks of `size` bytes each, counting how many were pulled and whether it was cancelled.
function chunked(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) return controller.close();
      state.pulled++;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

const bodyOf = (bytes: Uint8Array, chunkSize: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.byteLength; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });

const search = (client: AtgeoClient, signal?: AbortSignal) => client.searchPlaces({ region, signal });

describe("maxBodyBytes", () => {
  it("fails a body over the cap as a transport failure, with BodyTooLargeError", async () => {
    const fetch = tileFetch(() => new Response(tileOfSize(1025)));
    const result = await search(new AtgeoClient({ fetch, maxBodyBytes: 1024 }));
    expect(result.complete).toBe(false);
    expect(result.tileFailures).toEqual([{ url: TILE, kind: "transport", error: expect.any(BodyTooLargeError) }]);
    expect(result.tileFailures[0].error).toMatchObject({ name: "BodyTooLargeError", maxBodyBytes: 1024 });
  });

  it("accepts a body of exactly the cap", async () => {
    const fetch = tileFetch(() => new Response(tileOfSize(1024)));
    const result = await search(new AtgeoClient({ fetch, maxBodyBytes: 1024 }));
    expect(result.tileFailures).toEqual([]);
    expect(result.places).toHaveLength(1);
  });

  it("accepts a body of exactly the cap that arrives in many chunks, and refuses one byte more", async () => {
    for (const [size, ok] of [[1024, true], [1025, false]] as const) {
      const fetch = tileFetch(() => new Response(bodyOf(tileOfSize(size), 7)));
      const result = await search(new AtgeoClient({ fetch, maxBodyBytes: 1024 }));
      expect(result.tileFailures.map((f) => f.kind)).toEqual(ok ? [] : ["transport"]);
    }
  });

  it("measures bytes, not characters", async () => {
    // 'é' is two bytes: a document of 1024 bytes holds fewer characters than that.
    const bytes = tileOfSize(1024, "é".repeat(20));
    expect(new TextDecoder().decode(bytes).length).toBeLessThan(1024);
    const at = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(bytes)), maxBodyBytes: 1024 }));
    expect(at.tileFailures).toEqual([]);
    const under = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(bytes)), maxBodyBytes: 1023 }));
    expect(under.tileFailures.map((f) => f.kind)).toEqual(["transport"]);
  });

  it("stops reading and cancels the stream once the cap is passed", async () => {
    const { body, state } = chunked(10_000, 1024);
    const result = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(body)), maxBodyBytes: 10 * 1024 }));
    expect(result.tileFailures.map((f) => f.kind)).toEqual(["transport"]);
    expect(state.cancelled).toBe(true);
    // The stream's own queue may hold one chunk ahead of the reader; the other ~10,000 were never made.
    expect(state.pulled).toBeLessThan(20);
  });

  it("caps an unbounded stream", async () => {
    const forever = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(4096)) });
    const result = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(forever)), maxBodyBytes: 100_000 }));
    expect(result.tileFailures.map((f) => f.kind)).toEqual(["transport"]);
  });

  it("defaults to 32 MiB", async () => {
    const MiB = 1024 * 1024;
    const over = chunked(33, MiB);
    const result = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(over.body)) }));
    expect(result.tileFailures).toEqual([{ url: TILE, kind: "transport", error: expect.any(BodyTooLargeError) }]);
    expect(result.tileFailures[0].error).toMatchObject({ maxBodyBytes: 32 * MiB });
    const exact = tileOfSize(32 * MiB);
    const ok = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(bodyOf(exact, MiB))) }));
    expect(ok.tileFailures).toEqual([]);
  });

  it("applies to every request, so an oversize getTiles answer rejects the search", async () => {
    const fetch = (async () => new Response(new Uint8Array(2000).fill(0x20))) as typeof globalThis.fetch;
    await expect(search(new AtgeoClient({ fetch, maxBodyBytes: 1000 }))).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("applies to an error body, which is otherwise read to build the AtgeoError", async () => {
    const fetch = tileFetch(() => new Response(new Uint8Array(2000).fill(0x20), { status: 500 }));
    const result = await search(new AtgeoClient({ fetch, maxBodyBytes: 1000 }));
    expect(result.tileFailures.map((f) => f.kind)).toEqual(["transport"]);
  });

  it("decodes a character split across chunks", async () => {
    const bytes = tileOfSize(2000, "€ café 🌍");
    for (const chunkSize of [1, 2, 3]) {
      const fetch = tileFetch(() => new Response(bodyOf(bytes, chunkSize)));
      const result = await search(new AtgeoClient({ fetch }));
      expect(result.places.map((h) => h.place.name)).toEqual(["€ café 🌍"]);
    }
  });

  it("drops a leading BOM, as response.text() does", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...tileOfSize(1000)]);
    const result = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(bodyOf(bytes, 1))) }));
    expect(result.tileFailures).toEqual([]);
  });

  describe("a response with no body stream", () => {
    const withoutStream = (response: Response) => Object.defineProperty(response, "body", { value: null });

    it("is read whole", async () => {
      const fetch = tileFetch(() => withoutStream(new Response(tileOfSize(500))));
      const result = await search(new AtgeoClient({ fetch }));
      expect(result.tileFailures).toEqual([]);
      expect(result.places).toHaveLength(1);
    });

    it("still obeys the cap, once read", async () => {
      const fetch = tileFetch(() => withoutStream(new Response(tileOfSize(1025))));
      const result = await search(new AtgeoClient({ fetch, maxBodyBytes: 1024 }));
      expect(result.tileFailures).toEqual([{ url: TILE, kind: "transport", error: expect.any(BodyTooLargeError) }]);
    });

    // A Response with no stream whose arrayBuffer never settles.
    const stalledWithoutStream = () =>
      Object.defineProperty(withoutStream(new Response(tileOfSize(500))), "arrayBuffer", { value: () => new Promise(() => {}) });

    it("times out while being read", async () => {
      const result = await search(new AtgeoClient({ fetch: tileFetch(stalledWithoutStream), requestTimeoutMs: 30 }));
      expect(result.tileFailures).toEqual([{ url: TILE, kind: "transport", error: expect.anything() }]);
      expect(result.tileFailures[0].error).toMatchObject({ name: "TimeoutError" });
    });

    it("rejects with the caller's reason when the caller aborts while it is read", async () => {
      const reason = new Error("stop");
      const controller = new AbortController();
      const p = search(new AtgeoClient({ fetch: tileFetch(stalledWithoutStream), requestTimeoutMs: 60_000 }), controller.signal);
      setTimeout(() => controller.abort(reason), 20);
      await expect(p).rejects.toBe(reason);
    });

    it("is an empty body when the Response is genuinely empty, which fails to decode", async () => {
      const result = await search(new AtgeoClient({ fetch: tileFetch(() => new Response(null)) }));
      expect(result.tileFailures.map((f) => f.kind)).toEqual(["decode"]);
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity, "1024" as unknown as number])("rejects maxBodyBytes %s", (value) => {
    expect(() => new AtgeoClient({ maxBodyBytes: value })).toThrow(TypeError);
  });
});

describe("requestTimeoutMs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A fetch that waits for its signal, as a real one does.
  const stalledFetch = (init: RequestInit | undefined) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

  // Headers arrive; the body never finishes. Tied to the signal, as a real fetch's is.
  const stalledBody = (init: RequestInit | undefined) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`{"records":[`));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      }),
    );

  // Headers arrive; the body never finishes, and the stream knows nothing of the signal.
  const deafBody = () =>
    new Response(new ReadableStream<Uint8Array>({ start: (c) => void c.enqueue(encoder.encode(`{"records":[`)) }));

  const isTimeout = (error: unknown) => error instanceof DOMException && error.name === "TimeoutError";

  it("fails a tile that does not answer in time, as transport", async () => {
    const result = await search(new AtgeoClient({ fetch: tileFetch(stalledFetch), requestTimeoutMs: 30 }));
    expect(result.complete).toBe(false);
    expect(result.tileFailures).toEqual([{ url: TILE, kind: "transport", error: expect.anything() }]);
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
  });

  it.each([
    ["a body tied to the signal", stalledBody],
    ["a body that ignores the signal", deafBody],
  ])("covers reading the body: %s", async (_name, tile) => {
    const result = await search(new AtgeoClient({ fetch: tileFetch(tile), requestTimeoutMs: 30 }));
    expect(result.tileFailures.map((f) => f.kind)).toEqual(["transport"]);
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
  });

  it("covers a body that trickles: the limit is on the whole request, not on silence", async () => {
    const trickle = () => {
      let timer: ReturnType<typeof setInterval>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => controller.enqueue(encoder.encode(" ")), 10);
          },
          cancel() {
            clearInterval(timer);
          },
        }),
      );
    };
    const result = await search(new AtgeoClient({ fetch: tileFetch(trickle), requestTimeoutMs: 100 }));
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
  });

  it("rejects the search when getTiles times out", async () => {
    const p = search(new AtgeoClient({ fetch: ((_: unknown, init?: RequestInit) => stalledFetch(init)) as typeof fetch, requestTimeoutMs: 30 }));
    await expect(p).rejects.toSatisfy(isTimeout);
  });

  it("reports a timeout as TimeoutError even when fetch rejects with a bare AbortError", async () => {
    const fetch = tileFetch(
      (init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))),
        ),
    );
    const result = await search(new AtgeoClient({ fetch, requestTimeoutMs: 30 }));
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
  });

  it("cuts off a fetch that ignores its signal while waiting for headers", async () => {
    const deaf = () => new Promise<Response>(() => {});
    const result = await search(new AtgeoClient({ fetch: tileFetch(deaf), requestTimeoutMs: 30 }));
    expect(result.tileFailures).toEqual([{ url: TILE, kind: "transport", error: expect.anything() }]);
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
  });

  it("cancels the body of a response that arrives after the timeout", async () => {
    let cancelled = false;
    let answer!: () => void;
    const late = () =>
      new Promise<Response>((resolve) => {
        answer = () =>
          resolve(new Response(new ReadableStream<Uint8Array>({ pull: () => {}, cancel: () => void (cancelled = true) })));
      });
    const result = await search(new AtgeoClient({ fetch: tileFetch(late), requestTimeoutMs: 30 }));
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
    answer();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("cancels the body of a response that arrives in the same turn as the timeout", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull: () => {}, cancel: () => void (cancelled = true) });
    // Resolves just after the timer fires, in the same timer pass.
    const fetch = tileFetch(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(body)), 30)));
    const p = search(new AtgeoClient({ fetch, requestTimeoutMs: 30 }));
    await vi.advanceTimersByTimeAsync(30);
    const result = await p;
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("does not time out a request that finishes in time", async () => {
    const late = () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(tileOfSize(600))), 20));
    const result = await search(new AtgeoClient({ fetch: tileFetch(late), requestTimeoutMs: 2000 }));
    expect(result.tileFailures).toEqual([]);
  });

  it("gives each request its own time", async () => {
    vi.useFakeTimers();
    const after = (ms: number, make: () => Response) => new Promise<Response>((resolve) => setTimeout(() => resolve(make()), ms));
    // getTiles and the tile take 60 ms each: together longer than the 100 ms limit, neither alone.
    const fetch = (async (input: RequestInfo | URL) => {
      if (new Request(input).url.includes("/xrpc/")) return after(60, () => new Response(JSON.stringify({ tiles: [TILE] })));
      return after(60, () => new Response(tileOfSize(600)));
    }) as typeof globalThis.fetch;
    const p = search(new AtgeoClient({ fetch, requestTimeoutMs: 100 }));
    await vi.advanceTimersByTimeAsync(200);
    const result = await p;
    expect(result.tileFailures).toEqual([]);
    expect(result.places).toHaveLength(1);
  });

  it("defaults to 30 seconds", async () => {
    vi.useFakeTimers();
    const p = search(new AtgeoClient({ fetch: tileFetch(stalledFetch) }));
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await p;
    expect(isTimeout(result.tileFailures[0].error)).toBe(true);
  });

  it("leaves no timer behind once a request is done", async () => {
    vi.useFakeTimers();
    const client = new AtgeoClient({ fetch: tileFetch(() => new Response(tileOfSize(600))) });
    await search(client);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -5, 1.5, NaN, Infinity, 2 ** 31, "30" as unknown as number])(
    "rejects requestTimeoutMs %s",
    (value) => {
      expect(() => new AtgeoClient({ requestTimeoutMs: value })).toThrow(TypeError);
    },
  );

  it("accepts the largest delay a timer honours", () => {
    expect(() => new AtgeoClient({ requestTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
  });
});

describe("a caller's abort is not a timeout", () => {
  const reason = new Error("user navigated away");
  const stalls = (init: RequestInit | undefined) =>
    new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("rejects with the caller's reason when it aborts a stalled header wait", async () => {
    const controller = new AbortController();
    const p = search(new AtgeoClient({ fetch: tileFetch(stalls), requestTimeoutMs: 60_000 }), controller.signal);
    setTimeout(() => controller.abort(reason), 20);
    await expect(p).rejects.toBe(reason);
  });

  it("rejects with the caller's reason when it aborts a stalled body, tied to the signal or not", async () => {
    for (const tied of [true, false]) {
      const controller = new AbortController();
      const fetch = tileFetch((init) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode("{"));
            if (tied) init?.signal?.addEventListener("abort", () => c.error(init.signal?.reason));
          },
        });
        return new Response(body);
      });
      const p = search(new AtgeoClient({ fetch, requestTimeoutMs: 60_000 }), controller.signal);
      setTimeout(() => controller.abort(reason), 20);
      await expect(p).rejects.toBe(reason);
    }
  });

  it("rejects with an AbortError when the caller aborts with no reason", async () => {
    const controller = new AbortController();
    const p = search(new AtgeoClient({ fetch: tileFetch(stalls) }), controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when the signal is already aborted, without a request that outlives it", async () => {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(search(new AtgeoClient({ fetch: tileFetch(stalls) }), controller.signal)).rejects.toBe(reason);
  });

  it("keeps a timeout a timeout when the caller has a signal that never aborts", async () => {
    const controller = new AbortController();
    // A signal that is never aborted must not turn a timeout into an abort.
    const result = await search(new AtgeoClient({ fetch: tileFetch(stalls), requestTimeoutMs: 20 }), controller.signal);
    expect(result.tileFailures[0].error).toMatchObject({ name: "TimeoutError" });
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("the calls that are not tile fetches", () => {
  const origin = "urn:atgeo:overturemaps.org:place:x";
  const calls: Record<string, (client: AtgeoClient) => Promise<unknown>> = {
    getPlace: (client) => client.getPlace({ origin }),
    describeService: (client) => client.describeService(),
    describeTileset: (client) => client.describeTileset("overture-place"),
  };
  const big = () => new Response(new Uint8Array(2000).fill(0x20));
  const stalledHeaders = (_: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const stalledBody = (_: unknown, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("{"));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      }),
    );

  it.each(Object.entries(calls))("%s rejects with the raw BodyTooLargeError for an oversize body", async (_name, call) => {
    const client = new AtgeoClient({ fetch: (async () => big()) as unknown as typeof fetch, maxBodyBytes: 1000 });
    await expect(call(client)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it.each(Object.entries(calls))("%s rejects with the raw TimeoutError when the headers stall", async (_name, call) => {
    const client = new AtgeoClient({ fetch: stalledHeaders as unknown as typeof fetch, requestTimeoutMs: 30 });
    await expect(call(client)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it.each(Object.entries(calls))("%s rejects with the raw TimeoutError when the body stalls", async (_name, call) => {
    const client = new AtgeoClient({ fetch: stalledBody as unknown as typeof fetch, requestTimeoutMs: 30 });
    await expect(call(client)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it.each(Object.entries(calls))("%s accepts a body of exactly the cap", async (name, call) => {
    const body = JSON.stringify(name === "getPlace" ? { record: { name: "x" } } : { did: "did:web:x", tilesets: [], slug: "s", collections: [] });
    const fetch = (async () => new Response(body)) as unknown as typeof globalThis.fetch;
    await expect(call(new AtgeoClient({ fetch, maxBodyBytes: encoder.encode(body).byteLength }))).resolves.toBeDefined();
    await expect(call(new AtgeoClient({ fetch, maxBodyBytes: encoder.encode(body).byteLength - 1 }))).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
