import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import type { PlaceValue, Region } from "../src/index.js";
import { haversine } from "../src/region.js";
import { bboxLocation, fakeServer, overture, place, placeOrigin, point, record, type FakeTileset } from "./helpers/fakeServer.js";

const url = (n: string) => `https://tiles.example/${n}.json`;
const idOf = (origin: string | null) => String(origin).slice(placeOrigin("").length);

async function search(records: PlaceValue[], region: Region) {
  const server = fakeServer({ tilesets: [overture([{ url: url("t"), records: records.map((v) => record(v)) }])] });
  const client = new AtgeoClient({ fetch: server.fetch });
  const result = await client.searchPlaces({ region });
  return result.places.map((h) => idOf(h.origin)).sort();
}

const DIVISION = { dataset: "overturemaps.org", collection: "division" };
const divisions = (tiles: FakeTileset["tiles"]): FakeTileset => ({ slug: "overture-division", collections: [DIVISION], tiles });
const division = (id: string, name: string, lat = 37.775) =>
  place(id, name, [point(lat, -122.415)], { origin: `urn:atgeo:overturemaps.org:division:${id}` });

describe("deduplication", () => {
  const first = place("dup", "First copy", [point(37.775, -122.415)]);
  const second = place("dup", "Second copy", [point(37.775, -122.415)]);
  const region: Region = { bbox: [-122.42, 37.77, -122.41, 37.78] };

  it("collapses a duplicate origin across tiles to one result", async () => {
    const server = fakeServer({
      tilesets: [
        overture([
          { url: url("a"), records: [record(first), record(place("a-only", "A", [point(37.772, -122.412)]))] },
          { url: url("b"), records: [record(second), record(place("b-only", "B", [point(37.773, -122.413)]))] },
        ]),
      ],
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(result.places.map((h) => idOf(h.origin)).sort()).toEqual(["a-only", "b-only", "dup"]);
  });

  it("keeps the first tile's copy in the default order too", async () => {
    const server = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [record(first)] }, { url: url("b"), records: [record(second)] }])],
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region });
    expect(result.places.map((h) => h.place.name)).toEqual(["First copy"]);
  });

  it("merges a division record held by two tiles into one hit", async () => {
    const server = fakeServer({
      tilesets: [
        divisions([
          { url: url("a"), records: [record(division("d1", "Springfield"))] },
          { url: url("b"), records: [record(division("d1", "Springfield"))] },
        ]),
      ],
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({
      dataset: "overturemaps.org",
      collection: "division",
      region,
    });
    expect(result.places).toHaveLength(1);
    expect(result.places[0].origin).toBe("urn:atgeo:overturemaps.org:division:d1");
  });

  it.each([
    ["lower", "a", "z", "East copy"],
    ["higher", "z", "a", "West copy"],
  ])("keeps the lowest-URL copy across an antimeridian split (east tile URL sorts %s)", async (_order, eastName, westName, winner) => {
    const server = fakeServer({
      tilesets: [
        overture([
          { url: url(eastName), records: [record(place("x", "East copy", [point(15, 175)]))] },
          { url: url(westName), records: [record(place("x", "West copy", [point(15, -175)]))] },
        ]),
      ],
      tilesFor: (bbox) => [bbox.startsWith("170") ? url(eastName) : url(westName)],
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region: { bbox: [170, 10, -170, 20] } });
    expect(result.places.map((h) => h.place.name)).toEqual([winner]);
  });

  it("keeps two records that have neither origin nor uri", async () => {
    const anonymous = (name: string) => place("x", name, [point(37.775, -122.415)], { origin: undefined });
    const server = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [record(anonymous("One")), record(anonymous("Two"))] }])],
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ dataset: "overturemaps.org", region });
    expect(result.places.map((h) => h.place.name).sort()).toEqual(["One", "Two"]);
    expect(result.places.every((h) => h.origin === null)).toBe(true);
  });

  it("identifies an origin-less record by its uri", async () => {
    const value = place("x", "By uri", [point(37.775, -122.415)], { origin: undefined });
    const server = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [record(value, undefined, "https://example.org/r/1")] }])],
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ dataset: "overturemaps.org", region });
    expect(result.places.map((h) => h.origin)).toEqual(["https://example.org/r/1"]);
  });
});

describe("ordering ties", () => {
  const region: Region = { bbox: [-122.42, 37.77, -122.41, 37.78] };

  it("orders records equal on score, importance and distance by origin, null last", async () => {
    const same = (id: string, extra: PlaceValue = {}) => record(place(id, "Same", [point(37.775, -122.415)], extra), 5);
    const server = fakeServer({
      tilesets: [
        overture([
          { url: url("a"), records: [same("x", { origin: undefined }), same("c"), same("a"), same("b")] },
        ]),
      ],
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ dataset: "overturemaps.org", region });
    expect(result.places.map((h) => h.origin)).toEqual([placeOrigin("a"), placeOrigin("b"), placeOrigin("c"), null]);
  });
});

describe("region filtering: bbox", () => {
  const region: Region = { bbox: [-122.4194, 37.7749, -122.415, 37.7799] };

  it("drops a point inside the snapped box but outside the region", async () => {
    const kept = await search(
      [
        place("in", "In", [point(37.777, -122.417)]),
        place("south", "South", [point(37.771, -122.417)]),
        place("east", "East", [point(37.777, -122.411)]),
        place("far", "Far", [point(40, -100)]),
      ],
      region,
    );
    expect(kept).toEqual(["in"]);
  });

  it("keeps a point on the region boundary", async () => {
    const kept = await search([place("edge", "Edge", [point(37.7749, -122.4194)])], region);
    expect(kept).toEqual(["edge"]);
  });

  it("passes bbox-only records by intersection", async () => {
    const kept = await search(
      [
        place("overlap", "Overlap", [bboxLocation(37.776, 37.7, -122.416, -122.5)]),
        place("encloses", "Encloses", [bboxLocation(38, 37, -122, -123)]),
        place("inside", "Inside", [bboxLocation(37.777, 37.776, -122.417, -122.418)]),
        place("north", "North", [bboxLocation(38, 37.9, -122.416, -122.418)]),
        place("west", "West", [bboxLocation(37.777, 37.776, -122.5, -122.6)]),
      ],
      region,
    );
    expect(kept).toEqual(["encloses", "inside", "overlap"]);
  });

  it("tests a record with both point and bbox on the point", async () => {
    const kept = await search(
      [
        place("point-out", "Point out", [point(40, -100), bboxLocation(38, 37, -122, -123)]),
        place("point-in", "Point in", [bboxLocation(10, 9, 10, 9), point(37.777, -122.417)]),
      ],
      region,
    );
    expect(kept).toEqual(["point-in"]);
  });

  it("drops records with no parseable location", async () => {
    const kept = await search(
      [
        place("ok", "Ok", [point(37.777, -122.417)]),
        place("none", "None", []),
        place("address", "Address", [{ $type: "community.lexicon.location.address", country: "US", street: "1 Main St" }]),
        place("garbage", "Garbage", [{ ...point(0, 0), latitude: "north-ish" }]),
        { $type: "org.atgeo.place", origin: placeOrigin("missing"), name: "Missing" },
      ],
      region,
    );
    expect(kept).toEqual(["ok"]);
  });

  it("handles a crossing region against points and crossing bboxes", async () => {
    const kept = await search(
      [
        place("east-side", "E", [point(0, 175)]),
        place("west-side", "W", [point(0, -175)]),
        place("prime", "P", [point(0, 0)]),
        place("crossing-box", "X", [bboxLocation(1, -1, -175, 178)]),
        place("far-box", "F", [bboxLocation(1, -1, 100, 90)]),
      ],
      { bbox: [170, -10, -170, 10] },
    );
    expect(kept).toEqual(["crossing-box", "east-side", "west-side"]);
  });
});

describe("region filtering: circle", () => {
  it("uses the true radius, not the enclosing square", async () => {
    const lat = 37.7749;
    const lon = -122.4194;
    const kept = await search(
      [
        place("near", "Near", [point(lat + 0.003, lon)]),
        place("corner", "Corner", [point(lat + 0.004, lon + 0.005)]),
        place("beyond", "Beyond", [point(lat + 0.005, lon)]),
      ],
      { lat, lon, radius: 500 },
    );
    expect(kept).toEqual(["near"]);
  });

  it("passes bbox-only records by nearest-point distance", async () => {
    const kept = await search(
      [
        place("close-box", "Close", [bboxLocation(0.4, 0.3, 0.4, 0.3)]),
        place("corner-box", "Corner", [bboxLocation(0.5, 0.4, 0.5, 0.4)]),
        place("surrounding", "Surrounding", [bboxLocation(1, -1, 1, -1)]),
      ],
      { lat: 0, lon: 0, radius: 55597 },
    );
    expect(kept).toEqual(["close-box", "surrounding"]);
  });

  it("keeps a high-latitude bbox-only record that clips the circle, with distance within the radius", async () => {
    const lat = 85;
    const radius = 370000;
    // Measured to the box edge along the center's parallel: 379.9 km. The true nearest point is 357.1 km.
    const box = place("clipping", "Clipping", [bboxLocation(89, 80, 50, 40)]);
    expect(haversine(lat, 0, lat, 40)).toBeGreaterThan(radius);
    const server = fakeServer({ tilesets: [overture([{ url: url("t"), records: [record(box)] }])] });
    const { places } = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region: { lat, lon: 0, radius } });
    expect(places.map((h) => idOf(h.origin))).toEqual(["clipping"]);
    expect(places[0].distance).toBeLessThanOrEqual(radius);
  });

  it("finds the nearest longitude around the antimeridian", async () => {
    const kept = await search(
      [
        place("near-edge", "Near", [bboxLocation(1, -1, 180, 170)]),
        place("far-edge", "Far", [bboxLocation(1, -1, 170, 160)]),
        place("crossing", "Crossing", [bboxLocation(1, -1, -170, 170)]),
      ],
      { lat: 0, lon: -175, radius: 667170 },
    );
    expect(kept).toEqual(["crossing", "near-edge"]);
  });

  it("measures point distance across the antimeridian", async () => {
    const kept = await search(
      [
        place("p-wrap", "Wrap", [point(0, 179.5)]),
        place("p-far", "Far", [point(0, 178)]),
        place("p-same", "Same", [point(0, -176)]),
      ],
      { lat: 0, lon: -175, radius: 667170 },
    );
    expect(kept).toEqual(["p-same", "p-wrap"]);
  });
});

describe("determinism", () => {
  const permutations = (xs: string[]): string[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  const tiles = [
    {
      url: url("a"),
      records: [
        record(place("dup", "Copy A", [point(37.775, -122.415)]), 5),
        record(place("a1", "Alpha", [point(37.772, -122.412)]), 5),
        record(place("a2", "Alpha", [point(37.772, -122.412)]), 5),
      ],
    },
    {
      url: url("b"),
      records: [
        record(place("dup", "Copy B", [point(37.775, -122.415)]), 5),
        record(place("b1", "Alpha", [point(37.772, -122.412)]), 5),
      ],
    },
    {
      url: url("c"),
      records: [
        record(place("dup", "Copy C", [point(37.775, -122.415)]), 5),
        record(place("c1", "Alpha", [point(37.772, -122.412)]), 5),
      ],
    },
  ];
  const region: Region = { bbox: [-122.42, 37.77, -122.41, 37.78] };

  async function run(arrival: string[], text?: string) {
    const server = fakeServer({ tilesets: [overture(tiles)] });
    const delayed: typeof fetch = async (input, init) => {
      const href = new Request(input).url;
      const rank = arrival.findIndex((n) => href === url(n));
      if (rank >= 0) await new Promise((r) => setTimeout(r, rank * 15));
      return server.fetch(input, init);
    };
    const client = new AtgeoClient({ fetch: delayed });
    return JSON.stringify(await client.searchPlaces({ region, text }));
  }

  it.each([undefined, "Alpha"])("gives identical output for every tile arrival order (text %j)", async (text) => {
    const outputs = await Promise.all(permutations(["a", "b", "c"]).map((order) => run(order, text)));
    expect(new Set(outputs).size).toBe(1);
    const parsed = JSON.parse(outputs[0]);
    expect(parsed.places.map((h: { origin: string }) => idOf(h.origin)).sort()).toEqual(["a1", "a2", "b1", "c1", "dup"]);
    expect(parsed.places.find((h: { origin: string }) => idOf(h.origin) === "dup").place.name).toBe("Copy A");
  });
});
