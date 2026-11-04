import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import type { Region } from "../src/index.js";
import { degreeBbox } from "../src/region.js";
import { OVERTURE, fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

const COORD = /^-?\d{1,3}\.\d{2}$/;

function setup() {
  const server = fakeServer();
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

async function emitted(region: Region): Promise<string[]> {
  const { server, client } = setup();
  await client.searchNearby({ ...OVERTURE, region });
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
    await client.searchNearby({ ...OVERTURE, region });
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

  it("widens longitude to the spherical cap's half-width", async () => {
    const [bbox] = await emitted({ lat: 60, lon: 10, radius: 111194.927 });
    const [minLon, minLat, maxLon, maxLat] = parse(bbox);
    expect(minLat).toBeCloseTo(59, 1);
    expect(maxLat).toBeCloseTo(61, 1);
    expect(minLon).toBeLessThanOrEqual(8);
    expect(minLon).toBeGreaterThanOrEqual(7.99);
    expect(maxLon).toBeGreaterThanOrEqual(12);
    expect(maxLon).toBeLessThanOrEqual(12.01);
  });

  // asin(sin 20° / cos 60°) = 43.16°; the flat 20° / cos 60° is 40°.
  it("reaches the cap's true east and west edges at high latitude", async () => {
    expect(await emitted({ lat: 60, lon: 0, radius: 20 * 111194.927 })).toEqual(["-43.17,40.00,43.17,80.00"]);
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
    const result = await client.searchNearby({ ...OVERTURE, region: { bbox: [170, 10, -170, 20] } });
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
    expect(() => client.searchNearby({ ...OVERTURE, region })).toThrow(TypeError);
    expect(() => client.searchNearby({ ...OVERTURE, region })).toThrow(/^invalid (bbox|circle)$/);
    expect(server.requests).toHaveLength(0);
  });

  it("accepts minLon > maxLon", async () => {
    const { client } = setup();
    await expect(client.searchNearby({ ...OVERTURE, region: { bbox: [170, 0, -170, 1] } })).resolves.toBeDefined();
  });

  it("throws TypeError synchronously for similarity sort without text", () => {
    const { server, client } = setup();
    expect(() =>
      client.searchNearby({ ...OVERTURE, region: { bbox: [0, 0, 1, 1] }, sort: "similarity" }),
    ).toThrow(TypeError);
    expect(() =>
      client.searchNearby({ ...OVERTURE, region: { bbox: [0, 0, 1, 1] }, sort: "similarity" }),
    ).toThrow(/similarity/);
    expect(server.requests).toHaveLength(0);
  });
});

describe("degreeBbox", () => {
  const box = (bbox: [number, number, number, number]): Region => ({ bbox });

  it.each([
    ["snaps outward to whole degrees", box([-122.4194155, 37.7749295, -122.4094155, 37.7849295]), "-123,37,-122,38"],
    ["keeps whole degrees as they are", box([10, 20, 12, 22]), "10,20,12,22"],
    ["treats a corner within 1e-9 of a whole degree as that degree", box([10 + 1e-10, 20 - 1e-10, 12 + 1e-10, 22 - 1e-10]), "10,20,12,22"],
    ["does not treat a corner 1e-8 past a whole degree as on it", box([10.00000001, 20, 12.00000001, 22]), "10,20,13,22"],
    ["snaps a box that straddles zero", box([-0.5, -0.5, 0.5, 0.5]), "-1,-1,1,1"],
  ] as [string, Region, string][])("%s", (_name, region, expected) => {
    expect(degreeBbox(region)).toBe(expected);
  });

  it.each([
    ["widens a zero-height box north", box([0, 10, 5, 10]), "0,10,5,11"],
    ["widens a zero-height box at 90 south", box([0, 90, 5, 90]), "0,89,5,90"],
    ["widens a zero-height box at -90 north", box([0, -90, 5, -90]), "0,-90,5,-89"],
    ["widens a zero-width box east", box([10, 0, 10, 5]), "10,0,11,5"],
    ["widens a zero-width box at 180 across the seam", box([180, 0, 180, 5]), "179,0,-179,5"],
    ["widens a zero-width box at -180 across the seam", box([-180, 0, -180, 5]), "179,0,-179,5"],
    ["snaps a sub-degree box outward to one degree on both axes", box([10.2, 20.2, 10.2, 20.2]), "10,20,11,21"],
  ] as [string, Region, string][])("%s", (_name, region, expected) => {
    expect(degreeBbox(region)).toBe(expected);
  });

  it.each([
    ["keeps a crossing box crossing", box([170.5, 10, -170.5, 20]), "170,10,-170,20"],
    ["clamps a west edge of 180 to 179", box([180, 0, -170, 1]), "179,0,-170,1"],
    ["clamps an east edge of -180 to -179", box([170, 0, -180, 1]), "170,0,-179,1"],
    ["clamps both seam edges", box([180, 0, -180, 1]), "179,0,-179,1"],
    ["carries a box ending at 180 a degree past the seam", box([170, 0, 180, 1]), "170,0,-179,1"],
    ["carries a box starting at -180 a degree past the seam", box([-180, 0, -170, 1]), "179,0,-170,1"],
    ["sends full longitude when a box ending at 180 starts at or west of 0", box([-10, 0, 180, 1]), "-180,0,180,1"],
    ["sends full longitude when a box starting at -180 ends at or east of 0", box([-180, 0, 10, 1]), "-180,0,180,1"],
    ["keeps a box spanning -180 to 180", box([-180, 0, 180, 1]), "-180,0,180,1"],
    ["sends full longitude when snapping closes the gap", box([0.5, 0, 0.2, 1]), "-180,0,180,1"],
    ["sends full longitude when the east side snaps to 0", box([5, 0, -0.2, 1]), "-180,0,180,1"],
    ["sends full longitude when both sides are east of 0", box([5, 0, 3, 1]), "-180,0,180,1"],
    ["sends full longitude when both sides are west of 0", box([-3, 0, -5, 1]), "-180,0,180,1"],
    ["keeps the latitude band when it sends full longitude", box([5, 10.5, 3, 12.5]), "-180,10,180,13"],
  ] as [string, Region, string][])("%s", (_name, region, expected) => {
    expect(degreeBbox(region)).toBe(expected);
  });

  it("writes negative zero as 0", () => {
    expect(degreeBbox(box([-0, -0, 0, 0]))).toBe("0,0,1,1");
    expect(degreeBbox(box([-5, -5, -0.2, -0.2]))).toBe("-5,-5,0,0");
  });

  it.each([
    ["a circle", { lat: 10, lon: 20, radius: 111194.927 }, "18,9,22,11"],
    ["a radius-0 circle off the grid", { lat: 37.5, lon: -122.5, radius: 0 }, "-123,37,-122,38"],
    ["a radius-0 circle on the grid", { lat: 20, lon: 10, radius: 0 }, "10,20,11,21"],
    ["a circle across the antimeridian", { lat: 0, lon: 179.75, radius: 55597.4635 }, "179,-1,-179,1"],
    ["a circle centred on the antimeridian", { lat: 0, lon: 180, radius: 55597.4635 }, "179,-1,-179,1"],
    ["a circle holding the north pole", { lat: 89.5, lon: 10, radius: 111194.927 }, "-180,88,180,90"],
    ["a circle holding the south pole", { lat: -89.5, lon: 10, radius: 111194.927 }, "-180,-90,180,-88"],
  ] as [string, Region, string][])("uses the enclosing box of %s", (_name, region, expected) => {
    expect(degreeBbox(region)).toBe(expected);
  });

  describe("containment", () => {
    const TOL = 1e-9;
    const RAD = Math.PI / 180;
    const segments = (w: number, e: number): [number, number][] => (w <= e ? [[w, e]] : [[w, 180], [-180, e]]);
    const parts = (out: string) => out.split(",").map(Number);

    const wellFormed = (out: string) => {
      const [w, s, e, n] = parts(out);
      expect(out.split(",").every((c) => /^-?\d+$/.test(c) && c !== "-0")).toBe(true);
      expect(s).toBeLessThan(n);
      expect(w < e || (w > 0 && e < 0 && !(w === 180 && e === -180))).toBe(true);
      // A box touches the seam on both sides or neither: one ending at 180 would miss a place stored at -180.
      expect(w === -180).toBe(e === 180);
    };
    const lonIn = (lon: number, out: [number, number][]) => out.some(([a, b]) => lon >= a - TOL && lon <= b + TOL);

    it("contains every bbox of a grid and has whole-degree, server-valid output", () => {
      const lons = [-180, -179.5, -10.3, -0.2, 0, 0.7, 10, 179.2, 180];
      const lats = [-90, -45.5, -0.3, 0, 12.2, 89.4, 90];
      for (const minLon of lons) {
        for (const maxLon of lons) {
          for (const minLat of lats) {
            for (const maxLat of lats.filter((l) => l >= minLat)) {
              const out = degreeBbox({ bbox: [minLon, minLat, maxLon, maxLat] });
              const [w, s, e, n] = parts(out);
              wellFormed(out);
              expect(s).toBeLessThanOrEqual(minLat + TOL);
              expect(n).toBeGreaterThanOrEqual(maxLat - TOL);
              const outSegments = segments(w, e);
              for (const [lo, hi] of segments(minLon, maxLon)) {
                const covered = outSegments.some(([a, b]) => a <= lo + TOL && b >= hi - TOL);
                expect(covered, `${[minLon, minLat, maxLon, maxLat]} -> ${out}`).toBe(true);
              }
            }
          }
        }
      }
    });

    it("contains points around every circle of a grid and has whole-degree, server-valid output", () => {
      const lats = [-90, -60, -0.4, 0, 37.77, 89.5, 90];
      const lons = [-180, -179.9, 0, 0.3, 122.4, 179.9, 180];
      const radii = [0, 1, 500, 50000, 500000, 3e6];
      for (const lat of lats) {
        for (const lon of lons) {
          for (const radius of radii) {
            const out = degreeBbox({ lat, lon, radius });
            wellFormed(out);
            const [w, s, e, n] = parts(out);
            const outSegments = segments(w, e);
            const d = radius / 111194.927 * RAD;
            for (let k = 0; k < 24; k++) {
              const theta = (k * 15 * Math.PI) / 180;
              const lat2 = Math.asin(Math.sin(lat * RAD) * Math.cos(d) + Math.cos(lat * RAD) * Math.sin(d) * Math.cos(theta));
              let lon2 =
                lon +
                (Math.atan2(Math.sin(theta) * Math.sin(d) * Math.cos(lat * RAD), Math.cos(d) - Math.sin(lat * RAD) * Math.sin(lat2)) / RAD);
              if (lon2 > 180) lon2 -= 360;
              if (lon2 < -180) lon2 += 360;
              const label = `${lat},${lon},${radius} at ${k * 15} deg -> ${out}`;
              expect(lat2 / RAD, label).toBeGreaterThanOrEqual(s - TOL);
              expect(lat2 / RAD, label).toBeLessThanOrEqual(n + TOL);
              // A point at lon 180 or -180 is the same meridian: either side counts.
              const inside = lonIn(lon2, outSegments) || (Math.abs(Math.abs(lon2) - 180) < 1e-6 && (lonIn(180, outSegments) || lonIn(-180, outSegments)));
              expect(inside, label).toBe(true);
            }
          }
        }
      }
    });
  });
});
