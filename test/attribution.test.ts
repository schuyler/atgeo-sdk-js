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
function serverFor(s: Scenario): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const href = new Request(input).url;
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

const pairKey = (h: { origin: string | null; collection: unknown }) => JSON.stringify([h.origin, h.collection]);

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
    const got = result.places.map((h) => ({ origin: h.origin, collection: h.collection }));
    expect(got.map(pairKey).sort()).toEqual(s.expect.hits.map(pairKey).sort());
    for (const g of got) {
      const want = s.expect.hits.find((h) => pairKey(h) === pairKey(g));
      expect(g.collection).toStrictEqual(want!.collection);
    }
  });
});
