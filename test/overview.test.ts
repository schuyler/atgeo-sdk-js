import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { OVERTURE, fakeServer, overture, place, point, record, type TilesFor } from "./helpers/fakeServer.js";

const east = "https://tiles.example/east.json";
const west = "https://tiles.example/west.json";
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const tiles = [
  { url: east, records: [record(place("e", "East", [point(37.773, -122.413)]))] },
  { url: west, records: [record(place("w", "West", [point(37.772, -122.412)]))] },
];

function setup(tilesFor?: TilesFor, failTiles: string[] = []) {
  const server = fakeServer({ failTiles, tilesFor, tilesets: [overture(tiles)] });
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

const tilesCount = (requests: { url: string }[]) => requests.filter((r) => r.url.includes("org.atgeo.getTiles")).length;

describe("overview answers", () => {
  it("flags an overview answer whose tiles all load as overview and complete", async () => {
    const { client } = setup(() => ({ tiles: [east, west], overview: true }));
    const result = await client.searchPlaces({ ...OVERTURE, region });
    expect(result.overview).toBe(true);
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty("summary");
  });

  it("does not flag a regular answer with a failed tile", async () => {
    const { client } = setup(undefined, [west]);
    const result = await client.searchPlaces({ ...OVERTURE, region });
    expect(result.overview).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("reads an answer without the key as regular", async () => {
    const { client } = setup(() => ({ tiles: [east, west] }));
    expect((await client.searchPlaces({ ...OVERTURE, region })).overview).toBe(false);
  });

  it("keeps the flag when the tile-list cache answers", async () => {
    const { server, client } = setup(() => ({ tiles: [east, west], overview: true }));
    await client.searchPlaces({ ...OVERTURE, region });
    const second = await client.searchPlaces({ ...OVERTURE, region });
    expect(tilesCount(server.requests)).toBe(1);
    expect(second.overview).toBe(true);
  });

  it("flags a split antimeridian search when only one half is overview", async () => {
    const { client } = setup((bbox) =>
      bbox.startsWith("170") ? { tiles: [east], overview: true } : { tiles: [west] },
    );
    const result = await client.searchPlaces({ ...OVERTURE, region: { bbox: [170, 10, -170, 20] as [number, number, number, number] } });
    expect(result.overview).toBe(true);
  });
});
