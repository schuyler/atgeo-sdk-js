import { describe, expect, it } from "vitest";
import fixture from "../fixtures/keyword-fallback.json" with { type: "json" };
import { AtgeoClient } from "../src/index.js";
import type { Region } from "../src/index.js";

// fixtures/keyword-fallback.json: searchNearbyThenByKeyword (contract: the solid-hit decision and the
// merge). The bodies need not validate against the lexicons, so the server here is raw: it answers
// getTiles with the scenario's tile urls in listed order, each tile with its body, and searchPlaces
// with keywordAnswer, recording every request.

interface Scenario {
  name: string;
  description: string;
  dataset: string;
  collection?: string;
  region: Region;
  keyword: string;
  keywordRegion: "none" | "degree";
  sort?: "fused" | "distance" | "similarity";
  tiles: { url: string; body: unknown }[];
  keywordAnswer: unknown;
  expect: {
    keywordRequested: boolean;
    bbox?: string;
    origins: string[];
    disclosed: { keyword: boolean; region: 0.01 | 1 | null };
  };
}

const scenarios = fixture as unknown as Scenario[];
const SERVER = "https://places.atgeo.org";

function serverFor(s: Scenario) {
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const href = new Request(input).url;
    requests.push(href);
    if (href.startsWith(`${SERVER}/xrpc/org.atgeo.getTiles`)) return new Response(JSON.stringify({ tiles: s.tiles.map((t) => t.url) }));
    if (href.startsWith(`${SERVER}/xrpc/org.atgeo.searchPlaces`)) return new Response(JSON.stringify(s.keywordAnswer));
    const tile = s.tiles.find((t) => t.url === href);
    return tile ? new Response(JSON.stringify(tile.body)) : new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("keyword fallback scenarios", () => {
  it("has the scenarios the contract describes", () => {
    expect(scenarios).toHaveLength(6);
  });

  // A fresh client per scenario: scenarios reuse tile urls, and the caches are keyed by dataset, collection and bbox.
  it.each(scenarios)("$name", async (s) => {
    const { fetch, requests } = serverFor(s);
    const result = await new AtgeoClient({ fetch }).searchNearbyThenByKeyword({
      dataset: s.dataset,
      ...(s.collection === undefined ? {} : { collection: s.collection }),
      region: s.region,
      keyword: s.keyword,
      keywordRegion: s.keywordRegion,
      ...(s.sort === undefined ? {} : { sort: s.sort }),
    });

    expect(result.places.map((h) => h.origin)).toEqual(s.expect.origins);
    expect(result.disclosed).toEqual(s.expect.disclosed);

    const keywordRequests = requests.filter((u) => u.startsWith(`${SERVER}/xrpc/org.atgeo.searchPlaces`));
    expect(keywordRequests).toHaveLength(s.expect.keywordRequested ? 1 : 0);
    if (s.expect.keywordRequested) {
      const params = Object.fromEntries(new URL(keywordRequests[0]).searchParams);
      expect(params).toEqual({
        dataset: s.dataset,
        ...(s.collection === undefined ? {} : { collection: s.collection }),
        q: s.keyword,
        ...(s.expect.bbox === undefined ? {} : { bbox: s.expect.bbox }),
      });
    }
  });
});

describe("searchNearbyThenByKeyword arguments", () => {
  const dataset = "overturemaps.org";
  const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
  const valid = { dataset, region, keyword: "Starbux", keywordRegion: "none" as const };

  // Each case is wrong in its own way and in every way after it, so the message names the first.
  it.each([
    ["dataset", { ...valid, dataset: undefined, keyword: 5, keywordRegion: "x", region: { bbox: [0, 10, 1, 5] }, sort: "similarity" }, /dataset/],
    ["keyword", { ...valid, keyword: 5, keywordRegion: "x", region: { bbox: [0, 10, 1, 5] }, sort: "similarity" }, /^(?!.*keywordRegion).*keyword/i],
    ["keywordRegion", { ...valid, keywordRegion: "x", region: { bbox: [0, 10, 1, 5] }, sort: "similarity", keyword: "  " }, /keywordRegion/],
    ["region", { ...valid, region: { bbox: [0, 10, 1, 5] }, sort: "similarity", keyword: "  " }, /invalid bbox/],
    ["sort", { ...valid, sort: "similarity", keyword: "  " }, /similarity/],
  ])("refuses a bad %s first, with no request", async (_which, options, message) => {
    const { fetch, requests } = serverFor({ tiles: [] } as unknown as Scenario);
    const client = new AtgeoClient({ fetch });
    expect(client).toHaveProperty("searchNearbyThenByKeyword");
    const outcome = (async () => client.searchNearbyThenByKeyword(options as never))();
    await expect(outcome).rejects.toThrow(TypeError);
    await expect(outcome).rejects.toThrow(message);
    expect(requests).toHaveLength(0);
  });
});
