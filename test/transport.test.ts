import { describe, expect, it } from "vitest";
import { AtgeoClient, AtgeoError } from "../src/index.js";
import { DEFAULT_SERVER, PLACES, fakeServer, place, point } from "./helpers/fakeServer.js";

const url = (n: string) => `https://tiles.example/${n}.json`;
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };

function twoTiles(failTiles: string[] = []) {
  return fakeServer({
    failTiles,
    collections: {
      [PLACES]: {
        tiles: [
          { url: url("a"), records: [place("a", "A", [point(37.772, -122.412)])] },
          { url: url("b"), records: [place("b", "B", [point(37.774, -122.414)])] },
        ],
      },
    },
  });
}

describe("failed tiles", () => {
  it("reports a complete search", async () => {
    const server = twoTiles();
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(result.complete).toBe(true);
    expect(result.tiles).toEqual({ fetched: 2, failed: 0 });
  });

  it("returns surviving results, marked incomplete, when a tile answers non-200", async () => {
    const server = twoTiles([url("b")]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(result.complete).toBe(false);
    expect(result.tiles).toEqual({ fetched: 1, failed: 1 });
    expect(result.places.map((h) => h.place.rkey)).toEqual(["a"]);
  });

  it("returns an incomplete result when a tile fetch rejects", async () => {
    const server = twoTiles();
    const flaky: typeof fetch = (input, init) =>
      new Request(input).url === url("a") ? Promise.reject(new TypeError("boom")) : server.fetch(input, init);
    const result = await new AtgeoClient({ fetch: flaky }).searchPlaces({ region });
    expect(result.complete).toBe(false);
    expect(result.tiles).toEqual({ fetched: 1, failed: 1 });
    expect(result.places.map((h) => h.place.rkey)).toEqual(["b"]);
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
  });
});

describe("typed server errors", () => {
  it("surfaces BboxTooLarge from getCoverage", async () => {
    const server = fakeServer({
      collections: {
        [PLACES]: { tiles: [], coverage: () => ({ error: "BboxTooLarge", message: "bbox too large" }) },
      },
    });
    const p = new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "BboxTooLarge" });
  });

  it("surfaces CollectionNotFound from getCoverage", async () => {
    const server = fakeServer({ collections: { [PLACES]: { tiles: [] } } });
    const p = new AtgeoClient({ fetch: server.fetch }).searchPlaces({ collection: "org.example.nope", region });
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "CollectionNotFound" });
  });

  it.each([
    ["first", "170"],
    ["second", "-180"],
  ])("throws when the %s antimeridian half is BboxTooLarge", async (_half, prefix) => {
    const server = fakeServer({
      collections: {
        [PLACES]: {
          tiles: [{ url: url("a"), records: [place("a", "A", [point(15, 175)])] }],
          coverage: (bbox) => (bbox.startsWith(prefix) ? { error: "BboxTooLarge", message: "too large" } : [url("a")]),
        },
      },
    });
    const p = new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region: { bbox: [170, 10, -170, 20] } });
    await expect(p).rejects.toMatchObject({ code: "BboxTooLarge" });
  });

  it("does not subdivide after BboxTooLarge", async () => {
    const server = fakeServer({
      collections: {
        [PLACES]: { tiles: [], coverage: () => ({ error: "BboxTooLarge", message: "too large" }) },
      },
    });
    await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region }).catch(() => {});
    expect(server.requests).toHaveLength(1);
  });
});

describe("XRPC URLs", () => {
  it("defaults to places.atgeo.org", async () => {
    const server = twoTiles();
    await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    const u = new URL(server.requests[0].url);
    expect(u.origin + u.pathname).toBe(`${DEFAULT_SERVER}/xrpc/org.atgeo.getCoverage`);
    expect(u.searchParams.get("collection")).toBe(PLACES);
    expect(u.searchParams.get("bbox")).toBe("-122.42,37.77,-122.41,37.78");
  });

  it("targets a custom server for every XRPC call", async () => {
    const base = "http://localhost:8000";
    const server = fakeServer({
      server: base,
      collections: {
        [PLACES]: {
          tiles: [{ url: `${base}/tiles/a.json`, records: [place("a", "A", [point(37.772, -122.412)])] }],
          metadata: { collection: PLACES },
        },
      },
    });
    const client = new AtgeoClient({ server: base, fetch: server.fetch });
    await client.searchPlaces({ region });
    await client.describeService();
    await client.getPlace({ collection: PLACES, rkey: "zzz" }).catch(() => {});
    const xrpc = server.requests
      .filter((r) => r.url.includes("/xrpc/"))
      .map((r) => {
        const u = new URL(r.url);
        return u.origin + u.pathname;
      });
    expect(xrpc).toEqual([
      `${base}/xrpc/org.atgeo.getCoverage`,
      `${base}/xrpc/org.atgeo.describeService`,
      `${base}/xrpc/com.atproto.repo.getRecord`,
    ]);
    expect(server.requests.map((r) => r.url)).toContain(`${base}/tiles/a.json`);
  });
});
