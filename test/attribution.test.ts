import { describe, expect, it } from "vitest";
import fixture from "../fixtures/attribution-scenarios.json" with { type: "json" };
import { AtgeoClient } from "../src/index.js";
import type { Region } from "../src/index.js";

// fixtures/attribution-scenarios.json: SearchResult.attribution and SearchHit.collection (contract
// sections 4.10 and 8). The bodies need not validate against the lexicons, so the server here is raw.

interface Scenario {
  name: string;
  description: string;
  dataset: string;
  collection?: string;
  region: Region;
  tiles: { url: string; body?: unknown; status?: number }[];
  expect: {
    attribution: unknown[];
    hits: { origin: string | null; collection: { dataset: string; collection: string } | null }[];
  };
}

const scenarios = fixture as unknown as Scenario[];
const SERVER = "https://places.atgeo.org";
const GET_TILES = `${SERVER}/xrpc/org.atgeo.getTiles`;

// Answers every getTiles call with the scenario's urls in listed order, and each tile url exactly.
function serverFor(s: Scenario, delayMs: Record<string, number> = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const href = new Request(input).url;
    if (delayMs[href]) await new Promise((r) => setTimeout(r, delayMs[href]));
    if (href.startsWith(`${GET_TILES}?`) || href === GET_TILES) {
      return new Response(JSON.stringify({ tiles: s.tiles.map((t) => t.url) }));
    }
    const tile = s.tiles.find((t) => t.url === href);
    if (!tile) return new Response("Not found", { status: 404 });
    const status = tile.status ?? 200;
    const body = tile.body ?? { error: "InternalServerError", message: "upstream error" };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

type Pair = { origin: string | null; collection: { dataset: string; collection: string } | null };
const pairKey = (h: Pair) =>
  h.origin === null ? "null" : `${h.origin.length}:${h.origin}|${h.collection === null ? "null" : `${h.collection.dataset.length}:${h.collection.dataset}${h.collection.collection}`}`;

describe("attribution scenarios", () => {
  it("has the scenarios the contract describes", () => {
    expect(scenarios).toHaveLength(12);
  });

  // A fresh client per scenario: scenarios reuse tile urls with different bodies, and the tile-list
  // cache is keyed by dataset, collection and bbox.
  it.each(scenarios)("$name", async (s) => {
    const client = new AtgeoClient({ fetch: serverFor(s) });
    const result = await client.searchPlaces({
      dataset: s.dataset,
      ...(s.collection === undefined ? {} : { collection: s.collection }),
      region: s.region,
    });

    expect(result.attribution).toStrictEqual(s.expect.attribution);

    for (const hit of result.places) expect(hit).toHaveProperty("collection");
    const got: Pair[] = result.places.map((h) => ({ origin: h.origin, collection: h.collection }));
    expect(got.map(pairKey).sort()).toEqual(s.expect.hits.map(pairKey).sort());
    for (const g of got) {
      const want = s.expect.hits.find((h) => pairKey(h) === pairKey(g));
      expect(g.collection).toStrictEqual(want!.collection);
    }
  });
});

// The result must not depend on which tile arrives first (contract section 4.10 walks tiles in URL order).
describe("attribution scenarios, tiles arriving in reverse URL order", () => {
  const multi = scenarios.filter((s) => s.tiles.length > 1);

  it.each(multi)("$name", async (s) => {
    const urls = s.tiles.map((t) => t.url).sort();
    const delays = Object.fromEntries(urls.map((u, i) => [u, (urls.length - 1 - i) * 25]));
    const result = await new AtgeoClient({ fetch: serverFor(s, delays) }).searchPlaces({
      dataset: s.dataset,
      ...(s.collection === undefined ? {} : { collection: s.collection }),
      region: s.region,
    });
    expect(result.attribution).toStrictEqual(s.expect.attribution);
    const got: Pair[] = result.places.map((h) => ({ origin: h.origin, collection: h.collection }));
    expect(got.map(pairKey).sort()).toEqual(s.expect.hits.map(pairKey).sort());
  });
});

// No fixture scenario has hits from two tiles whose attributions differ, so these pin that each hit
// is matched against its own tile's attribution (contract section 8), with and without text.
describe("a hit's collection comes from its own tile", () => {
  const place = (origin: string, name: string) => ({
    value: {
      $type: "org.atgeo.place",
      origin,
      name,
      locations: [{ $type: "community.lexicon.location.geo", latitude: "37.770000", longitude: "-122.415000" }],
    },
  });
  const s: Scenario = {
    name: "two tiles, two collections",
    description: "",
    dataset: "d",
    region: { bbox: [-122.42, 37.76, -122.41, 37.78] },
    tiles: [
      { url: `${SERVER}/tiles/a.json`, body: { records: [place("urn:atgeo:d:c1:1", "Zzzzqqq")], attribution: [{ dataset: "d", collection: "c1" }] } },
      { url: `${SERVER}/tiles/b.json`, body: { records: [place("urn:atgeo:d:c2:2", "Cafe")], attribution: [{ dataset: "d", collection: "c2" }] } },
    ],
    expect: { attribution: [], hits: [] },
  };

  it("gives each hit the collection of its own tile, not of the first tile used", async () => {
    const result = await new AtgeoClient({ fetch: serverFor(s) }).searchPlaces({ dataset: "d", region: s.region });
    const byOrigin = Object.fromEntries(result.places.map((h) => [h.origin, h.collection]));
    expect(byOrigin).toStrictEqual({
      "urn:atgeo:d:c1:1": { dataset: "d", collection: "c1" },
      "urn:atgeo:d:c2:2": { dataset: "d", collection: "c2" },
    });
  });

  it("keeps each surviving hit with its own tile when the text drops another record", async () => {
    const result = await new AtgeoClient({ fetch: serverFor(s) }).searchPlaces({ dataset: "d", region: s.region, text: "Cafe" });
    expect(result.places.map((h) => [h.origin, h.collection])).toStrictEqual([["urn:atgeo:d:c2:2", { dataset: "d", collection: "c2" }]]);
  });
});
