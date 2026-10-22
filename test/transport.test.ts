import { afterEach, describe, expect, it, vi } from "vitest";
import { TileCache } from "../src/cache.js";
import { AtgeoClient, AtgeoError } from "../src/index.js";
import { DEFAULT_SERVER, fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

const url = (n: string) => `https://tiles.example/${n}.json`;
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };

function twoTiles(failTiles: string[] = []) {
  return fakeServer({
    failTiles,
    tilesets: [
      overture([
        { url: url("a"), records: [record(place("a", "A", [point(37.772, -122.412)]))] },
        { url: url("b"), records: [record(place("b", "B", [point(37.774, -122.414)]))] },
      ]),
    ],
  });
}

describe("failed tiles", () => {
  it("reports a complete search", async () => {
    const server = twoTiles();
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(result.complete).toBe(true);
    expect(result.tiles).toEqual({ fetched: 2, failed: 0 });
    expect(result.tileFailures).toEqual([]);
  });

  it("returns surviving results, marked incomplete, when a tile answers non-200", async () => {
    const server = twoTiles([url("b")]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(result.complete).toBe(false);
    expect(result.tiles).toEqual({ fetched: 1, failed: 1 });
    expect(result.places.map((h) => h.origin)).toEqual([placeOrigin("a")]);
  });

  it("returns an incomplete result when a tile fetch rejects", async () => {
    const server = twoTiles();
    const flaky: typeof fetch = (input, init) =>
      new Request(input).url === url("a") ? Promise.reject(new TypeError("boom")) : server.fetch(input, init);
    const result = await new AtgeoClient({ fetch: flaky }).searchPlaces({ region });
    expect(result.complete).toBe(false);
    expect(result.tiles).toEqual({ fetched: 1, failed: 1 });
    expect(result.places.map((h) => h.origin)).toEqual([placeOrigin("b")]);
  });

  it("does not retry a failed tile", async () => {
    const server = twoTiles([url("b")]);
    await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(server.requests.filter((r) => r.url === url("b"))).toHaveLength(1);
  });

  it("reports every tile failed without throwing", async () => {
    const server = twoTiles([url("a"), url("b")]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(result).toMatchObject({ places: [], complete: false, tiles: { fetched: 0, failed: 2 } });
    expect(result.tileFailures.map((f) => f.url)).toEqual([url("a"), url("b")]);
  });
});

// A server whose getTiles names exactly `tiles`' keys, in the given order, and answers each tile
// URL with its handler. Unlike fakeServer, the URLs need not be valid URIs.
const TILE_BODY = JSON.stringify({ records: [record(place("ok", "OK", [point(37.772, -122.412)]))] });
const ok = () => new Response(TILE_BODY);

function scripted(tiles: Record<string, () => Response | Promise<Response>>) {
  const requests: string[] = [];
  const handlers = new Map<string, () => Response | Promise<Response>>();
  for (const [key, handler] of Object.entries(tiles)) {
    let href = key;
    try {
      href = new URL(key).href;
    } catch {}
    handlers.set(href, handler);
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.url);
    if (request.url.startsWith(`${DEFAULT_SERVER}/xrpc/org.atgeo.getTiles`)) {
      return new Response(JSON.stringify({ tiles: Object.keys(tiles) }));
    }
    const handler = handlers.get(request.url);
    return handler ? handler() : new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const search = (fetch: typeof globalThis.fetch, signal?: AbortSignal) => new AtgeoClient({ fetch }).searchPlaces({ region, signal });

describe("tile failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["a relative path", "/tiles/a.json"],
    ["a relative reference", "tiles/a.json"],
    ["ftp", "ftp://tiles.example/a.json"],
    ["file", "file:///etc/passwd"],
    ["data", "data:application/json,{}"],
    ["a username and password", "https://user:pw@tiles.example/a.json"],
    ["a username", "https://user@tiles.example/a.json"],
    ["a password", "https://:pw@tiles.example/a.json"],
  ])("refuses %s without a request", async (_name, bad) => {
    const server = scripted({ [bad]: ok, [url("z")]: ok });
    const result = await search(server.fetch);
    expect(result.tileFailures).toEqual([{ url: bad, kind: "refused", error: expect.any(TypeError) }]);
    expect(result.tileFailures[0]).not.toHaveProperty("status");
    expect(result.tiles).toEqual({ fetched: 1, failed: 1 });
    expect(server.requests.filter((u) => !u.includes("/xrpc/"))).toEqual([url("z")]);
  });

  it("accepts an empty userinfo, as fetch does", async () => {
    const server = scripted({ "https://@tiles.example/a.json": ok });
    const result = await search(server.fetch);
    expect(result.tileFailures).toEqual([]);
    expect(result.tiles).toEqual({ fetched: 1, failed: 0 });
  });

  it("reports a non-2xx as status, with the status and its AtgeoError", async () => {
    const server = scripted({ [url("a")]: () => new Response(`{"error":"Gone","message":"tile gone"}`, { status: 410 }) });
    const result = await search(server.fetch);
    expect(result.tileFailures).toEqual([{ url: url("a"), kind: "status", status: 410, error: expect.any(AtgeoError) }]);
    expect(result.tileFailures[0].error).toMatchObject({ code: "Gone", status: 410 });
  });

  it.each([
    ["a body that is not JSON", "<html>"],
    ["a number", "5"],
    ["null", "null"],
    ["an array", "[]"],
    ["an object without records", "{}"],
    ["records that is not an array", `{"records":{}}`],
    ["a null record", `{"records":[null]}`],
  ])("reports %s as decode", async (_name, body) => {
    const server = scripted({ [url("a")]: () => new Response(body) });
    const result = await search(server.fetch);
    expect(result.tileFailures).toEqual([{ url: url("a"), kind: "decode", error: expect.any(Error) }]);
    expect(result.complete).toBe(false);
  });

  it("reports a fetch that throws as transport, with its error unwrapped", async () => {
    const boom = new TypeError("fetch failed");
    const server = scripted({ [url("a")]: () => Promise.reject(boom) });
    const result = await search(server.fetch);
    expect(result.tileFailures).toEqual([{ url: url("a"), kind: "transport", error: boom }]);
  });

  it("reports a body that fails to read as transport", async () => {
    const body = new ReadableStream({ start: (c) => c.error(new Error("connection reset")) });
    const server = scripted({ [url("a")]: () => new Response(body) });
    const result = await search(server.fetch);
    expect(result.tileFailures).toMatchObject([{ url: url("a"), kind: "transport" }]);
  });

  it("classifies by where an error arises, not its type", async () => {
    const own = new AtgeoError("Custom", "an app's fetch threw this itself", 418);
    const server = scripted({ [url("a")]: () => Promise.reject(own) });
    const result = await search(server.fetch);
    expect(result.tileFailures).toEqual([{ url: url("a"), kind: "transport", error: own }]);
  });

  it("lists failures in URL order, not completion order", async () => {
    const later = (response: () => Response, ms: number) => () => new Promise<Response>((r) => setTimeout(() => r(response()), ms));
    const server = scripted({
      [url("e")]: later(() => new Response("x"), 1),
      [url("d")]: ok,
      [url("c")]: later(() => new Response("", { status: 500 }), 15),
      "ftp://tiles.example/b.json": ok,
      [url("a")]: () => new Promise((_, reject) => setTimeout(() => reject(new TypeError("down")), 30)),
    });
    const result = await search(server.fetch);
    expect(result.tileFailures.map(({ url, kind, status }) => ({ url, kind, status }))).toEqual([
      { url: "ftp://tiles.example/b.json", kind: "refused", status: undefined },
      { url: url("a"), kind: "transport", status: undefined },
      { url: url("c"), kind: "status", status: 500 },
      { url: url("e"), kind: "decode", status: undefined },
    ]);
    expect(result.tiles).toEqual({ fetched: 1, failed: 4 });
  });

  it("rejects a cancelled search rather than reporting its tiles", async () => {
    const controller = new AbortController();
    const server = scripted({
      [url("a")]: () => {
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      },
    });
    await expect(search(server.fetch, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails the search when storing a tile in the cache throws", async () => {
    const bug = new Error("cache bug");
    vi.spyOn(TileCache.prototype, "set").mockImplementation(() => {
      throw bug;
    });
    const server = scripted({ [url("a")]: ok });
    await expect(search(server.fetch)).rejects.toBe(bug);
  });
});

describe("typed server errors", () => {
  it("surfaces BboxTooLarge from getTiles", async () => {
    const server = fakeServer({ tilesFor: () => ({ error: "BboxTooLarge", message: "bbox too large" }) });
    const p = new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "BboxTooLarge", status: 400 });
  });

  it("carries the HTTP status, whatever the body says", async () => {
    for (const [status, body] of [
      [404, `{"error":"PlaceNotFound"}`],
      [429, ""],
      [503, `{"error":"InvalidRequest","message":"a 5xx with a 4xx-sounding code"}`],
    ] as const) {
      const fetch = (async () => new Response(body, { status })) as typeof globalThis.fetch;
      const p = new AtgeoClient({ fetch }).getPlace({ origin: "urn:atgeo:overturemaps.org:place:x" });
      await expect(p).rejects.toMatchObject({ status });
    }
  });

  it("surfaces CollectionNotFound from getTiles", async () => {
    const server = fakeServer();
    const p = new AtgeoClient({ fetch: server.fetch }).searchPlaces({ collection: "nope", region });
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "CollectionNotFound" });
  });

  it("surfaces DatasetNotFound from getTiles", async () => {
    const server = fakeServer();
    const p = new AtgeoClient({ fetch: server.fetch }).searchPlaces({ dataset: "example.org", region });
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "DatasetNotFound" });
  });

  it.each([
    ["first", "170"],
    ["second", "-180"],
  ])("throws when the %s antimeridian half is BboxTooLarge", async (_half, prefix) => {
    const server = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [record(place("a", "A", [point(15, 175)]))] }])],
      tilesFor: (bbox) => (bbox.startsWith(prefix) ? { error: "BboxTooLarge", message: "too large" } : [url("a")]),
    });
    const p = new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region: { bbox: [170, 10, -170, 20] } });
    await expect(p).rejects.toMatchObject({ code: "BboxTooLarge" });
  });

  it("does not subdivide after BboxTooLarge", async () => {
    const server = fakeServer({ tilesFor: () => ({ error: "BboxTooLarge", message: "too large" }) });
    await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region }).catch(() => {});
    expect(server.requests).toHaveLength(1);
  });
});

describe("XRPC URLs", () => {
  it("defaults to places.atgeo.org", async () => {
    const server = twoTiles();
    await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    const u = new URL(server.requests[0].url);
    expect(u.origin + u.pathname).toBe(`${DEFAULT_SERVER}/xrpc/org.atgeo.getTiles`);
    expect(u.searchParams.get("dataset")).toBe("overturemaps.org");
    expect(u.searchParams.get("collection")).toBe("place");
    expect(u.searchParams.get("bbox")).toBe("-122.42,37.77,-122.41,37.78");
  });

  it("targets a custom server for every XRPC call", async () => {
    const base = "http://localhost:8000";
    const server = fakeServer({
      server: base,
      tilesets: [overture([{ url: `${base}/tiles/a.json`, records: [record(place("a", "A", [point(37.772, -122.412)]))] }])],
    });
    const client = new AtgeoClient({ server: base, fetch: server.fetch });
    await client.searchPlaces({ region });
    await client.describeService();
    await client.describeTileset("overture-place");
    await client.getPlace({ origin: placeOrigin("zzz") }).catch(() => {});
    const xrpc = server.requests
      .filter((r) => r.url.includes("/xrpc/"))
      .map((r) => {
        const u = new URL(r.url);
        return u.origin + u.pathname;
      });
    expect(xrpc).toEqual([
      `${base}/xrpc/org.atgeo.getTiles`,
      `${base}/xrpc/org.atgeo.describeService`,
      `${base}/xrpc/org.atgeo.describeTileset`,
      `${base}/xrpc/org.atgeo.getPlace`,
    ]);
    expect(server.requests.map((r) => r.url)).toContain(`${base}/tiles/a.json`);
  });
});
