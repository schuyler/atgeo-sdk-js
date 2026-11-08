import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { OVERTURE, fakeServer, overture, place, point, record } from "./helpers/fakeServer.js";

// What each result reports the server learned during that call (R4). The fallback's two branches
// are checked by the disclosed field of every scenario in fixtures/keyword-fallback.json, and the
// autocompleter's skip in autocomplete.test.ts.

const tiles = [{ url: "https://tiles.example/p.json", records: [record(place("zc", "Zanzibar Cafe", [point(37.772, -122.412)]), 5)] }];
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };

function setup() {
  const server = fakeServer({ tilesets: [overture(tiles)] });
  return new AtgeoClient({ fetch: server.fetch });
}

describe("disclosed", () => {
  it("is the 0.01 degree grid, no keyword, on a cold nearby search, whose hits come from tiles", async () => {
    const result = await setup().searchNearby({ ...OVERTURE, region, text: "Zanzibar" });
    expect(result.disclosed).toEqual({ keyword: false, region: 0.01 });
    expect(result.places.length).toBeGreaterThan(0);
    expect(result.places.every((h) => h.via === "tiles")).toBe(true);
  });

  it("reports no region for a nearby search answered from cache", async () => {
    const client = setup();
    await client.searchNearby({ ...OVERTURE, region });
    const warm = await client.searchNearby({ ...OVERTURE, region, text: "Zanzibar" });
    expect(warm.disclosed).toEqual({ keyword: false, region: null });
  });

  it("reports the keyword and a 1 degree region for a keyword search with a region", async () => {
    const result = await setup().searchByKeyword({ ...OVERTURE, keyword: "Zanzibar", region });
    expect(result.disclosed).toEqual({ keyword: true, region: 1 });
  });

  it("reports the keyword and no region for a keyword search without one", async () => {
    const result = await setup().searchByKeyword({ ...OVERTURE, keyword: "Zanzibar" });
    expect(result.disclosed).toEqual({ keyword: true, region: null });
  });
});

// #60: what counts as sent for the region (contract section 4.11).
describe("disclosed region counting", () => {
  it("counts a getTiles request as sent even when it lists no tiles", async () => {
    const server = fakeServer({ tilesets: [overture(tiles)], tilesFor: () => [] });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchNearby({ ...OVERTURE, region });
    expect(server.requests).toHaveLength(1);
    expect(result.disclosed).toEqual({ keyword: false, region: 0.01 });
  });

  it("does not count a tile the client refused to fetch", async () => {
    // The tile list is cached by the first search, so the second sends nothing: its only tile is refused.
    const server = fakeServer({ tilesets: [overture(tiles)], tilesFor: () => ["ftp://tiles.example/p.json"] });
    const client = new AtgeoClient({ fetch: server.fetch });
    await client.searchNearby({ ...OVERTURE, region });
    const before = server.requests.length;
    const warm = await client.searchNearby({ ...OVERTURE, region });
    expect(server.requests).toHaveLength(before);
    expect(warm.tileFailures.map((f) => f.kind)).toEqual(["refused"]);
    expect(warm.disclosed).toEqual({ keyword: false, region: null });
  });
});
