import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import type { Region } from "../src/index.js";
import { fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

const COORD = /^-?\d{1,3}\.\d{2}$/;

function setup() {
  const server = fakeServer();
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

async function emitted(region: Region): Promise<string[]> {
  const { server, client } = setup();
  await client.searchPlaces({ region });
  return server.requests
    .filter((r) => r.url.includes("org.atgeo.getTiles"))
    .map((r) => new URL(r.url).searchParams.get("bbox") ?? "");
}

const parse = (bbox: string) => bbox.split(",").map(Number);

describe("coordinate serialization", () => {
  const adversarial: [string, Region][] = [
    ["full GPS precision circle", { lat: 37.7749295, lon: -122.4194155, radius: 250.123456 }],
    ["full GPS precision bbox", { bbox: [-122.4194155, 37.7749295, -122.4094155, 37.7849295] }],
    ["trailing zeros", { bbox: [-122.4, 37.7, -122.3, 37.8] }],
    ["scientific notation tiny", { bbox: [1e-7, 1e-7, 2e-7, 2e-7] }],
    ["scientific notation", { bbox: [3.7749e1, 3.7749e1, 3.775e1, 3.776e1] }],
    ["negative scientific notation", { bbox: [-1e-7, -2e-7, 1e-7, 2e-7] }],
    ["tiny radius", { lat: 12.3456789, lon: 98.7654321, radius: 1e-9 }],
    ["radius zero", { lat: 12.3456789, lon: 98.7654321, radius: 0 }],
    ["zero-area bbox", { bbox: [10.123456, 20.123456, 10.123456, 20.123456] }],
    ["negative zero bbox", { bbox: [-0, -0, 0, 0] }],
    ["negative zero circle", { lat: -0, lon: -0, radius: 0 }],
    ["tiny negative", { bbox: [-0.0001, -0.0001, -0.00001, -0.00001] }],
    ["circle at pole", { lat: 90, lon: 0, radius: 1000 }],
    ["circle at antimeridian", { lat: 0, lon: 180, radius: 1000 }],
    ["crossing bbox", { bbox: [179.123456, 1.987654, -179.123456, 2.987654] }],
  ];

  it.each(adversarial)("emits only two-decimal coordinates: %s", async (_name, region) => {
    const { server, client } = setup();
    await client.searchPlaces({ region });
    const tileLists = server.requests.filter((r) => r.url.includes("org.atgeo.getTiles"));
    expect(tileLists.length).toBeGreaterThan(0);
    for (const r of tileLists) {
      const bbox = new URL(r.url).searchParams.get("bbox") ?? "";
      const parts = bbox.split(",");
      expect(parts).toHaveLength(4);
      for (const c of parts) expect(c).toMatch(COORD);
    }
  });

  it("never emits a coordinate outside the valid range", async () => {
    const regions: Region[] = [
      { bbox: [-180, -90, 180, 90] },
      { bbox: [180, 90, 180, 90] },
      { bbox: [-180, -90, -180, -90] },
      { lat: 90, lon: 180, radius: 5 },
      { lat: -90, lon: -180, radius: 5 },
      { lat: 89.999, lon: 179.999, radius: 100000 },
    ];
    for (const region of regions) {
      for (const bbox of await emitted(region)) {
        const [minLon, minLat, maxLon, maxLat] = parse(bbox);
        expect(minLon).toBeGreaterThanOrEqual(-180);
        expect(maxLon).toBeLessThanOrEqual(180);
        expect(minLat).toBeGreaterThanOrEqual(-90);
        expect(maxLat).toBeLessThanOrEqual(90);
        expect(minLon).toBeLessThan(maxLon);
        expect(minLat).toBeLessThan(maxLat);
      }
    }
  });
});

describe("outward snapping", () => {
  it("floors mins and ceils maxes", async () => {
    expect(await emitted({ bbox: [-122.4194155, 37.7749295, -122.4094155, 37.7849295] })).toEqual([
      "-122.42,37.77,-122.40,37.79",
    ]);
  });

  it("contains the caller's region for arbitrary precision input", async () => {
    const inputs: [number, number, number, number][] = [
      [-122.419415, 37.774929, -122.418001, 37.775001],
      [0.001, 0.002, 0.003, 0.004],
      [-0.004, -0.003, -0.002, -0.001],
      [151.2093, -33.8688, 151.2193, -33.8588],
      [-73.9857, 40.7484, -73.9757, 40.7584],
    ];
    for (const [minLon, minLat, maxLon, maxLat] of inputs) {
      const [bbox] = await emitted({ bbox: [minLon, minLat, maxLon, maxLat] });
      const [a, b, c, d] = parse(bbox);
      expect(a).toBeLessThanOrEqual(minLon);
      expect(b).toBeLessThanOrEqual(minLat);
      expect(c).toBeGreaterThanOrEqual(maxLon);
      expect(d).toBeGreaterThanOrEqual(maxLat);
      expect(c - a).toBeLessThan(maxLon - minLon + 0.0201);
      expect(d - b).toBeLessThan(maxLat - minLat + 0.0201);
    }
  });

  it("does not widen a grid-aligned bbox through float error", async () => {
    expect(await emitted({ bbox: [-122.42, 37.77, -122.41, 37.78] })).toEqual([
      "-122.42,37.77,-122.41,37.78",
    ]);
  });

  it("does not widen grid-aligned values anywhere on the grid", async () => {
    for (let k = 0; k < 9000; k += 97) {
      const lat = [(k + 1) / 100, (k + 6) / 100];
      const lon = [-(k + 8) / 100, -(k + 5) / 100];
      const expected = [lon[0], lat[0], lon[1], lat[1]].map((v) => v.toFixed(2)).join(",");
      expect(await emitted({ bbox: [lon[0], lat[0], lon[1], lat[1]] })).toEqual([expected]);
    }
  });
});

describe("degenerate spans", () => {
  it("widens a grid-aligned point by one step", async () => {
    expect(await emitted({ bbox: [10, 20, 10, 20] })).toEqual(["10.00,20.00,10.01,20.01"]);
  });

  it("widens a zero radius circle on the grid", async () => {
    expect(await emitted({ lat: 20, lon: 10, radius: 0 })).toEqual(["10.00,20.00,10.01,20.01"]);
  });

  it("widens negative zero", async () => {
    expect(await emitted({ bbox: [-0, -0, 0, 0] })).toEqual(["0.00,0.00,0.01,0.01"]);
  });

  it("widens a line", async () => {
    expect(await emitted({ bbox: [10, 20, 10.5, 20] })).toEqual(["10.00,20.00,10.50,20.01"]);
  });

  it("steps min down at latitude 90 and longitude 180", async () => {
    expect(await emitted({ bbox: [0, 90, 0, 90] })).toEqual(["0.00,89.99,0.01,90.00"]);
    expect(await emitted({ bbox: [180, 0, 180, 0] })).toEqual(["179.99,0.00,180.00,0.01"]);
  });

  it("does not widen a span that snapping already opened", async () => {
    expect(await emitted({ bbox: [10.005, 20.005, 10.005, 20.005] })).toEqual([
      "10.00,20.00,10.01,20.01",
    ]);
  });
});

describe("circle to bbox", () => {
  it("uses 111194.927 m per degree of latitude", async () => {
    expect(await emitted({ lat: 0, lon: 0, radius: 111194.927 })).toEqual(["-1.00,-1.00,1.00,1.00"]);
  });

  it("widens longitude by 1/cos(lat)", async () => {
    const [bbox] = await emitted({ lat: 60, lon: 10, radius: 111194.927 });
    const [minLon, minLat, maxLon, maxLat] = parse(bbox);
    expect(minLat).toBeCloseTo(59, 1);
    expect(maxLat).toBeCloseTo(61, 1);
    expect(minLon).toBeLessThanOrEqual(8);
    expect(minLon).toBeGreaterThanOrEqual(7.99);
    expect(maxLon).toBeGreaterThanOrEqual(12);
    expect(maxLon).toBeLessThanOrEqual(12.01);
  });

  it("covers all longitudes for a polar circle", async () => {
    const north = await emitted({ lat: 89.9, lon: 12.34, radius: 50000 });
    expect(north).toHaveLength(1);
    const [nMinLon, nMinLat, nMaxLon, nMaxLat] = parse(north[0]);
    expect([nMinLon, nMaxLon, nMaxLat]).toEqual([-180, 180, 90]);
    expect(nMinLat).toBeLessThanOrEqual(89.46);
    expect(nMinLat).toBeGreaterThanOrEqual(89.44);

    const south = await emitted({ lat: -89.9, lon: -45, radius: 50000 });
    expect(south).toHaveLength(1);
    const [sMinLon, sMinLat, sMaxLon, sMaxLat] = parse(south[0]);
    expect([sMinLon, sMaxLon, sMinLat]).toEqual([-180, 180, -90]);
    expect(sMaxLat).toBeLessThanOrEqual(-89.44);
    expect(sMaxLat).toBeGreaterThanOrEqual(-89.46);
  });
});

describe("antimeridian", () => {
  it("splits a crossing bbox into two getTiles calls", async () => {
    expect(await emitted({ bbox: [170, 10, -170, 20] })).toEqual([
      "170.00,10.00,180.00,20.00",
      "-180.00,10.00,-170.00,20.00",
    ]);
  });

  it("splits a circle that wraps past 180", async () => {
    expect(await emitted({ lat: 0, lon: 179.5, radius: 111194.927 })).toEqual([
      "178.50,-1.00,180.00,1.00",
      "-180.00,-1.00,-179.50,1.00",
    ]);
  });

  it("splits a circle that wraps past -180", async () => {
    expect(await emitted({ lat: 0, lon: -179.5, radius: 111194.927 })).toEqual([
      "179.50,-1.00,180.00,1.00",
      "-180.00,-1.00,-178.50,1.00",
    ]);
  });

  it("issues a single call for a non-crossing bbox", async () => {
    expect(await emitted({ bbox: [-10, 10, 10, 20] })).toHaveLength(1);
  });

  it("snaps each half independently", async () => {
    expect(await emitted({ bbox: [170.123, 10.123, -170.123, 20.123] })).toEqual([
      "170.12,10.12,180.00,20.13",
      "-180.00,10.12,-170.12,20.13",
    ]);
  });

  it("merges results from both halves", async () => {
    const west = "https://tiles.example/west.json";
    const east = "https://tiles.example/east.json";
    const server = fakeServer({
      tilesets: [
        overture([
          { url: west, records: [record(place("w", "West", [point(15, 175)]))] },
          { url: east, records: [record(place("e", "East", [point(15, -175)]))] },
        ]),
      ],
      tilesFor: (bbox) => (bbox.startsWith("170") ? [west] : [east]),
    });
    const client = new AtgeoClient({ fetch: server.fetch });
    const result = await client.searchPlaces({ region: { bbox: [170, 10, -170, 20] } });
    expect(result.places.map((h) => h.origin).sort()).toEqual([placeOrigin("e"), placeOrigin("w")]);
    expect(result.complete).toBe(true);
  });
});

describe("invalid regions", () => {
  const bad: [string, Region][] = [
    ["NaN lat", { lat: NaN, lon: 0, radius: 10 }],
    ["NaN lon", { lat: 0, lon: NaN, radius: 10 }],
    ["Infinity lon", { lat: 0, lon: Infinity, radius: 10 }],
    ["NaN radius", { lat: 0, lon: 0, radius: NaN }],
    ["Infinity radius", { lat: 0, lon: 0, radius: Infinity }],
    ["negative radius", { lat: 0, lon: 0, radius: -1 }],
    ["lat above 90", { lat: 90.01, lon: 0, radius: 10 }],
    ["lat below -90", { lat: -91, lon: 0, radius: 10 }],
    ["lon above 180", { lat: 0, lon: 180.5, radius: 10 }],
    ["lon below -180", { lat: 0, lon: -181, radius: 10 }],
    ["bbox NaN", { bbox: [0, 0, NaN, 1] }],
    ["bbox Infinity", { bbox: [0, 0, 1, Infinity] }],
    ["bbox -Infinity", { bbox: [-Infinity, 0, 1, 1] }],
    ["bbox minLat > maxLat", { bbox: [0, 10, 1, 5] }],
    ["bbox lat above 90", { bbox: [0, 0, 1, 91] }],
    ["bbox lat below -90", { bbox: [0, -91, 1, 0] }],
    ["bbox lon above 180", { bbox: [0, 0, 181, 1] }],
    ["bbox lon below -180", { bbox: [-181, 0, 1, 1] }],
  ];

  it.each(bad)("throws TypeError synchronously before any request: %s", (_name, region) => {
    const { server, client } = setup();
    expect(() => client.searchPlaces({ region })).toThrow(TypeError);
    expect(server.requests).toHaveLength(0);
  });

  it("accepts minLon > maxLon", async () => {
    const { client } = setup();
    await expect(client.searchPlaces({ region: { bbox: [170, 0, -170, 1] } })).resolves.toBeDefined();
  });

  it("throws TypeError synchronously for similarity sort without text", () => {
    const { server, client } = setup();
    expect(() =>
      client.searchPlaces({ region: { bbox: [0, 0, 1, 1] }, sort: "similarity" }),
    ).toThrow(TypeError);
    expect(server.requests).toHaveLength(0);
  });
});
