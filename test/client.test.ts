/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { AtgeoClient, AtgeoError } from "../src/index.js";
import { DEFAULT_SERVER, PLACES, bboxLocation, fakeServer, place, point } from "./helpers/fakeServer.js";

const url = (n: string) => `https://tiles.example/${n}.json`;
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const METADATA = { collection: PLACES, source: "https://example.org/source", recordCount: 3 };

describe("getPlace", () => {
  const value = place("r1", "Ferry Building", [point(37.7955, -122.3937)], {
    importance: 0.8,
    attributes: { kind: "landmark" },
    futureKey: { nested: [1, 2] },
  });

  function setup(server = DEFAULT_SERVER) {
    const fake = fakeServer({ server, collections: { [PLACES]: { tiles: [{ url: url("a"), records: [value] }] } } });
    return { fake, client: new AtgeoClient({ server, fetch: fake.fetch }) };
  }

  it("calls getRecord with the server's DID as repo, collection and rkey on a cache miss", async () => {
    const { fake, client } = setup();
    await client.getPlace({ collection: PLACES, rkey: "r1" });
    const u = new URL(fake.requests[fake.requests.length - 1].url);
    expect(u.origin + u.pathname).toBe(`${DEFAULT_SERVER}/xrpc/com.atproto.repo.getRecord`);
    expect(u.searchParams.get("repo")).toBe("did:web:places.atgeo.org");
    expect(u.searchParams.get("collection")).toBe(PLACES);
    expect(u.searchParams.get("rkey")).toBe("r1");
  });

  it("uses the DID a local server declares as repo, not its host and port", async () => {
    const { fake, client } = setup("http://localhost:8000");
    await client.getPlace({ collection: PLACES, rkey: "r1" });
    const u = new URL(fake.requests[fake.requests.length - 1].url);
    expect(u.searchParams.get("repo")).toBe("did:web:localhost");
  });

  it("reuses the cached service description across getPlace misses", async () => {
    const { fake, client } = setup();
    await client.getPlace({ collection: PLACES, rkey: "r1" });
    await client.getPlace({ collection: PLACES, rkey: "nope" }).catch(() => {});
    const describes = fake.requests.filter((r) => r.url.includes("org.atgeo.describeService"));
    expect(describes).toHaveLength(1);
  });

  it("returns a tile-shaped place with envelope importance reinserted", async () => {
    const { client } = setup();
    const record = await client.getPlace({ collection: PLACES, rkey: "r1" });
    expect(record.uri).toBe(`${DEFAULT_SERVER}/${PLACES}/r1`);
    expect(record.place).toEqual(value);
  });

  it("returns the same shape from the cache and the network", async () => {
    const { client } = setup();
    const network = await client.getPlace({ collection: PLACES, rkey: "r1" });
    await client.searchPlaces({ region: { bbox: [-122.40, 37.79, -122.39, 37.80] } });
    const cached = await client.getPlace({ collection: PLACES, rkey: "r1" });
    expect(cached).toEqual(network);
  });

  it("rejects an unknown rkey with RecordNotFound", async () => {
    const { client } = setup();
    const p = client.getPlace({ collection: PLACES, rkey: "nope" });
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "RecordNotFound" });
  });
});

describe("describeService and getCollectionInfo", () => {
  const OLD = "org.atgeo.places.old";
  function setup(wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch) {
    const fake = fakeServer({
      collections: {
        [PLACES]: { tiles: [], metadata: METADATA },
        [OLD]: { tiles: [] },
      },
    });
    return { fake, client: new AtgeoClient({ fetch: wrap ? wrap(fake.fetch) : fake.fetch }) };
  }

  it("describeService returns did and collections", async () => {
    const { client } = setup();
    const service = await client.describeService();
    expect(service.did).toBe("did:web:places.atgeo.org");
    expect(service.collections).toHaveLength(2);
    expect(service.collections.find((c) => c.collection === OLD)).toEqual({ collection: OLD });
    const withMetadata = service.collections.find((c) => c.collection === PLACES);
    expect(withMetadata?.metadata).toEqual(expect.any(String));
  });

  it("getCollectionInfo fetches the metadata URL as served and returns the record", async () => {
    const { fake, client } = setup();
    const served = (await client.describeService()).collections.find((c) => c.collection === PLACES)?.metadata;
    expect(await client.getCollectionInfo(PLACES)).toEqual(METADATA);
    expect(fake.requests.map((r) => r.url)).toContain(served);
  });

  it("getCollectionInfo returns null when the collection has no metadata", async () => {
    const { client } = setup();
    expect(await client.getCollectionInfo(OLD)).toBeNull();
  });

  it("getCollectionInfo throws CollectionNotFound for an unlisted collection", async () => {
    const { client } = setup();
    const p = client.getCollectionInfo("org.example.unlisted");
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "CollectionNotFound" });
  });

  it("getCollectionInfo raises RecordNotFound when the metadata URL answers 404", async () => {
    const { client } = setup((inner) => async (input, init) =>
      new Request(input).url.startsWith(`${DEFAULT_SERVER}/org.atgeo.collection/`)
        ? new Response(JSON.stringify({ error: "RecordNotFound", message: "gone" }), { status: 404 })
        : inner(input, init),
    );
    const p = client.getCollectionInfo(PLACES);
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "RecordNotFound" });
  });
});

describe("searchPlaces results", () => {
  const records = [
    place("cafe", "Zanzibar Cafe", [point(0.001, 0)], { importance: 2, futureKey: { a: 1 }, variants: [{ name: "ZC" }] }),
    place("shop", "Corner Shop", [point(0.002, 0)], { importance: 9 }),
    place("division", "Some Division", [bboxLocation(0.01, -0.01, 0.01, -0.01)], { importance: 1 }),
  ];
  const circle = { lat: 0, lon: 0, radius: 2000 };

  function setup() {
    const fake = fakeServer({ collections: { [PLACES]: { tiles: [{ url: url("a"), records }] } } });
    return new AtgeoClient({ fetch: fake.fetch });
  }

  it("returns uri, wire place, meters distance and null score without text", async () => {
    const result = await setup().searchPlaces({ region: circle });
    const cafe = result.places.find((h) => h.place.rkey === "cafe");
    expect(cafe?.uri).toBe(`${DEFAULT_SERVER}/${PLACES}/cafe`);
    expect(cafe?.place).toEqual(records[0]);
    expect(cafe?.distance).toBeCloseTo(111.195, 1);
    expect(result.places.every((h) => h.score === null)).toBe(true);
  });

  it("gives null distance to a record with no point", async () => {
    const result = await setup().searchPlaces({ region: circle });
    expect(result.places.find((h) => h.place.rkey === "division")?.distance).toBeNull();
  });

  it("returns a numeric score with text", async () => {
    const result = await setup().searchPlaces({ region: circle, text: "Zanzibar Cafe" });
    const cafe = result.places.find((h) => h.place.rkey === "cafe");
    expect(cafe?.score).toBeCloseTo(1, 2);
    expect(result.places.every((h) => typeof h.score === "number")).toBe(true);
  });

  it("treats text that normalizes to empty as no text", async () => {
    const client = setup();
    const none = await client.searchPlaces({ region: circle });
    const blank = await client.searchPlaces({ region: circle, text: "   " });
    expect(blank.places.length).toBeGreaterThan(0);
    expect(blank).toEqual(none);
    expect(blank.places.every((h) => h.score === null)).toBe(true);
  });
});

describe("universal runtime (R9)", () => {
  const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >;
  const NODE_MODULE =
    /(?:from|import|require)\s*\(?\s*["'](?:node:[^"']*|(?:assert|buffer|child_process|cluster|crypto|dns|events|fs|http|http2|https|net|os|path|perf_hooks|process|querystring|readline|stream|string_decoder|timers|tls|url|util|vm|worker_threads|zlib)(?:\/[^"']*)?)["']/;

  it("reads the source files", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(sources))("%s imports no Node builtins", (_file, text) => {
    expect(text).not.toMatch(NODE_MODULE);
  });

  it.each(Object.entries(sources))("%s references no DOM globals", (_file, text) => {
    expect(text).not.toMatch(/\b(?:window|document)\b/);
  });
});
