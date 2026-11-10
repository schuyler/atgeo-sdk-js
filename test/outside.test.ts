import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { bboxLocation, fakeServer, overture, place, point, record } from "./helpers/fakeServer.js";

// One tile that covers more than the search region: a park inside it, a park beyond it, and a place with no
// location, which belongs on neither side.
const view = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };

function setup(extra: Parameters<typeof record>[0][] = []) {
  const fake = fakeServer({
    tilesets: [
      overture([
        {
          url: "https://tiles.example/a.json",
          records: [
            record(place("in", "Dolores Cafe", [point(37.775, -122.415)]), 10),
            record(place("far", "Alamo Square Park", [point(37.776, -122.434)]), 50),
            record(place("box", "Alamo Square Historic District", [bboxLocation(37.78, 37.77, -122.43, -122.44)]), 20),
            record(place("nowhere", "Alamo Square Ghost", [])),
            ...extra.map((v) => record(v)),
          ],
        },
      ]),
    ],
  });
  return { fake, client: new AtgeoClient({ fetch: fake.fetch }) };
}

const names = (hits: { name: string | null }[]) => hits.map((h) => h.name);

describe("includeOutside", () => {
  it("is off by default: outside is an empty list", async () => {
    const { client } = setup();
    const result = await client.searchNearby({ dataset: "overturemaps.org", region: view, text: "alamo square park" });
    expect(result.places).toEqual([]);
    expect(result.outside).toEqual([]);
  });

  it("returns the located places the tiles hold beyond the region, filtered by text", async () => {
    const { client } = setup();
    const result = await client.searchNearby({
      dataset: "overturemaps.org",
      region: view,
      text: "alamo square park",
      includeOutside: true,
    });
    expect(result.places).toEqual([]);
    // The word match leads; a fuzzy match may follow it, as inside the region.
    expect(result.outside[0].name).toBe("Alamo Square Park");
    expect(names(result.outside)).not.toContain("Dolores Cafe");
    expect(result.outside[0].via).toBe("tiles");
    expect(result.outside[0].distance).toBeGreaterThan(1000);
  });

  it("keeps places and outside disjoint, and drops places without a location", async () => {
    const { client } = setup();
    const result = await client.searchNearby({ dataset: "overturemaps.org", region: view, includeOutside: true });
    expect(names(result.places)).toEqual(["Dolores Cafe"]);
    expect(names(result.outside).sort()).toEqual(["Alamo Square Historic District", "Alamo Square Park"]);
  });

  it("makes no request beyond what the plain search makes", async () => {
    const plain = setup();
    await plain.client.searchNearby({ dataset: "overturemaps.org", region: view });
    const wide = setup();
    const result = await wide.client.searchNearby({ dataset: "overturemaps.org", region: view, includeOutside: true });
    expect(wide.fake.requests.map((r) => r.url)).toEqual(plain.fake.requests.map((r) => r.url));
    expect(result.disclosed).toEqual({ keyword: false, region: 0.01 });
  });

  it("ranks outside by the sort mode, distance from the region's center", async () => {
    const { client } = setup();
    const result = await client.searchNearby({
      dataset: "overturemaps.org",
      region: view,
      sort: "distance",
      includeOutside: true,
    });
    const d = result.outside.map((h) => h.distance);
    expect(d).toEqual([...d].sort((a, b) => a - b));
  });
});
