import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { bboxLocation, fakeServer, overture, place, point, record } from "./helpers/fakeServer.js";

// One tile that covers more than the search region: a cafe inside it, a park beyond it, a historic district
// (a fuzzy-only match for the park) beyond it, and a place with no location.
const view = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const dataset = "overturemaps.org";

function setup() {
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
          ],
        },
      ]),
    ],
  });
  return { fake, client: new AtgeoClient({ fetch: fake.fetch }) };
}

const names = (hits: { name: string | null }[]) => hits.map((h) => h.name);

describe("expand", () => {
  it("is off by default for searchNearby: the region's answer stands, and expanded is false", async () => {
    const { client } = setup();
    const result = await client.searchNearby({ dataset, region: view, text: "alamo square park" });
    expect(result.places).toEqual([]);
    expect(result.expanded).toBe(false);
  });

  it("with no word match in the region, answers with the tile coverage, best match first", async () => {
    const { client } = setup();
    const result = await client.searchNearby({ dataset, region: view, text: "alamo square park", expand: true });
    expect(result.expanded).toBe(true);
    expect(result.places[0].name).toBe("Alamo Square Park");
    expect(result.places[0].distance).toBeGreaterThan(1000);
    // Points and bbox-only places both count; a place with no location does not.
    expect(names(result.places)).toEqual(["Alamo Square Park", "Alamo Square Historic District"]);
  });

  it("does not expand to fuzzy-only places: the tiles must hold a word match", async () => {
    const { client } = setup();
    // "sqare" matches "Alamo Square Park" only fuzzily, so there is no word match anywhere.
    const result = await client.searchNearby({ dataset, region: view, text: "alamo sqare park", expand: true });
    expect(result).toMatchObject({ expanded: false, places: [] });
  });

  it("does not expand when the region has a word match", async () => {
    const { client } = setup();
    const result = await client.searchNearby({ dataset, region: view, text: "dolores", expand: true });
    expect(result.expanded).toBe(false);
    expect(names(result.places)).toEqual(["Dolores Cafe"]);
  });

  it("expands past a fuzzy-only hit in the region", async () => {
    const fake = fakeServer({
      tilesets: [
        overture([
          {
            url: "https://tiles.example/b.json",
            records: [
              record(place("typo", "Alamo Squar Park Cafe", [point(37.775, -122.415)])),
              record(place("far", "Alamo Square Park", [point(37.776, -122.434)])),
            ],
          },
        ]),
      ],
    });
    const client = new AtgeoClient({ fetch: fake.fetch });
    const region = { dataset, region: view, text: "alamo square park" };
    const plain = await client.searchNearby(region);
    expect(names(plain.places)).toEqual(["Alamo Squar Park Cafe"]);
    const wide = await client.searchNearby({ ...region, expand: true });
    expect(wide.expanded).toBe(true);
    expect(wide.places[0].name).toBe("Alamo Square Park");
  });

  it("does not expand without text, or when the tiles hold no word match either", async () => {
    const { client } = setup();
    const noText = await client.searchNearby({ dataset, region: view, expand: true });
    expect(noText.expanded).toBe(false);
    expect(names(noText.places)).toEqual(["Dolores Cafe"]);
    const nothing = await client.searchNearby({ dataset, region: view, text: "zzzzqqqq", expand: true });
    expect(nothing).toMatchObject({ expanded: false, places: [] });
  });

  it("makes no request beyond what the plain search makes", async () => {
    const plain = setup();
    await plain.client.searchNearby({ dataset, region: view, text: "alamo square park" });
    const wide = setup();
    const result = await wide.client.searchNearby({ dataset, region: view, text: "alamo square park", expand: true });
    expect(wide.fake.requests.map((r) => r.url)).toEqual(plain.fake.requests.map((r) => r.url));
    expect(result.disclosed).toEqual({ keyword: false, region: 0.01 });
  });

  it("searchNearbyThenByKeyword expands by default, so a solid hit in the tiles sends no keyword", async () => {
    const { fake, client } = setup();
    const result = await client.searchNearbyThenByKeyword({
      dataset,
      region: view,
      keyword: "alamo square park",
      keywordRegion: "degree",
    });
    expect(result.expanded).toBe(true);
    expect(result.places[0]).toMatchObject({ name: "Alamo Square Park", via: "tiles" });
    expect(result.disclosed.keyword).toBe(false);
    expect(fake.requests.some((r) => r.url.includes("searchPlaces"))).toBe(false);
  });

  it("searchNearbyThenByKeyword can switch expand off, and then asks the server", async () => {
    const { fake, client } = setup();
    const result = await client.searchNearbyThenByKeyword({
      dataset,
      region: view,
      keyword: "alamo square park",
      keywordRegion: "degree",
      expand: false,
    });
    expect(result.expanded).toBe(false);
    expect(result.disclosed.keyword).toBe(true);
    expect(fake.requests.some((r) => r.url.includes("searchPlaces"))).toBe(true);
  });
});
