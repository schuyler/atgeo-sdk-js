import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { PLACES, fakeServer, type FakeCollection, place, point } from "./helpers/fakeServer.js";

const west = "https://tiles.example/west.json";
const east = "https://tiles.example/east.json";
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const tiles = [
  { url: west, records: [place("w", "West", [point(37.772, -122.412)])] },
  { url: east, records: [place("e", "East", [point(37.773, -122.413)])] },
];

function setup(
  coverage?: FakeCollection["coverage"],
  failTiles: string[] = [],
) {
  const server = fakeServer({ failTiles, collections: { [PLACES]: { tiles, coverage } } });
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

const coverageCount = (requests: { url: string }[]) =>
  requests.filter((r) => r.url.includes("org.atgeo.getCoverage")).length;

describe("summary answers", () => {
  it("flags a summary coverage whose tiles all load as summary and complete", async () => {
    const { client } = setup(() => ({ tiles: [west, east], summary: true }));
    const result = await client.searchPlaces({ region });
    expect(result.summary).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("does not flag a regular coverage with a failed tile", async () => {
    const { client } = setup(undefined, [east]);
    const result = await client.searchPlaces({ region });
    expect(result.summary).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("reads a coverage response without the key as regular", async () => {
    const { client } = setup(() => ({ tiles: [west, east] }));
    expect((await client.searchPlaces({ region })).summary).toBe(false);
  });

  it("keeps the flag when the coverage cache answers", async () => {
    const { server, client } = setup(() => ({ tiles: [west, east], summary: true }));
    await client.searchPlaces({ region });
    const second = await client.searchPlaces({ region });
    expect(coverageCount(server.requests)).toBe(1);
    expect(second.summary).toBe(true);
  });

  it("flags a split antimeridian search when only one half is summary", async () => {
    const { client } = setup((bbox) =>
      bbox.startsWith("170") ? { tiles: [west], summary: true } : { tiles: [east] },
    );
    const result = await client.searchPlaces({ region: { bbox: [170, 10, -170, 20] as [number, number, number, number] } });
    expect(result.summary).toBe(true);
  });
});
