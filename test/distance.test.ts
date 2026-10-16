import { describe, expect, it } from "vitest";
import { distanceTo, inRegion, locate } from "../src/merge.js";
import { haversine } from "../src/region.js";
import { bboxLocation, place, point } from "./helpers/fakeServer.js";

const boxAt = (south: number, north: number, west: number, east: number) =>
  locate(place("b", "Box", [bboxLocation(north, south, east, west)]));
const pointAt = (lat: number, lon: number) => locate(place("p", "Point", [point(lat, lon)]));

// Minimum haversine distance from the center to a dense sampling of the box boundary.
function sampledDistance(lat: number, lon: number, south: number, north: number, west: number, east: number): number {
  const steps = 100000;
  const spans = west <= east ? [[west, east]] : [[west, 180], [-180, east]];
  let best = Infinity;
  for (const [lo, hi] of spans) {
    for (let i = 0; i <= steps; i++) {
      const la = south + ((north - south) * i) / steps;
      const lo2 = lo + ((hi - lo) * i) / steps;
      for (const [a, b] of [[la, lo], [la, hi], [south, lo2], [north, lo2]]) {
        best = Math.min(best, haversine(lat, lon, a, b));
      }
    }
  }
  return best;
}

describe("distanceTo: containment is exactly zero", () => {
  it("for a latitude that does not survive a radian round trip", () => {
    expect(distanceTo(boxAt(46, 47, 10, 11), 46.0986, 10.5)).toBe(0);
  });

  it("for center lon 180 in a box with west -180", () => {
    expect(distanceTo(boxAt(40, 50, -180, -170), 45, 180)).toBe(0);
  });

  it("for center lon -180 in a box with east 180", () => {
    expect(distanceTo(boxAt(40, 50, 170, 180), 45, -180)).toBe(0);
  });

  it("for a pole center in a box reaching the pole whose longitudes exclude 0", () => {
    expect(distanceTo(boxAt(-90, -80, 10, 20), -90, 0)).toBe(0);
  });

  it("for a point exactly at the center", () => {
    expect(distanceTo(pointAt(46.0986, 10.5), 46.0986, 10.5)).toBe(0);
  });

  it.each([
    [180, -180],
    [-180, 180],
  ])("for a point at lon %d and a center at its seam twin %d", (pointLon, centerLon) => {
    expect(distanceTo(pointAt(10, pointLon), 10, centerLon)).toBe(0);
  });
});

describe("distanceTo: outside a box", () => {
  const cases: [string, number, number, [number, number, number, number]][] = [
    ["due south within the longitude range", 0, 5, [10, 20, 0, 10]],
    ["east of a high-latitude box", 65, 10, [60, 70, 20, 30]],
    ["more than 90 degrees of longitude away", 50, 0, [40, 60, 120, 140]],
    ["across the antimeridian from a box", 60, -179, [55, 65, 175, 179]],
    ["from an antimeridian-crossing box", 45, -160, [40, 50, 170, -170]],
    ["west of an antimeridian-crossing box", 45, 150, [40, 50, 170, -170]],
  ];

  it.each(cases)("matches the sampled boundary distance %s", (_name, lat, lon, [south, north, west, east]) => {
    const expected = sampledDistance(lat, lon, south, north, west, east);
    expect(distanceTo(boxAt(south, north, west, east), lat, lon)).toBeCloseTo(expected, 1);
  });

  it("is strictly less than the latitude-clamped distance for a high-latitude box to the east", () => {
    const clamped = haversine(65, 10, 65, 20);
    const actual = distanceTo(boxAt(60, 70, 20, 30), 65, 10) as number;
    expect(actual).toBeLessThan(clamped - 1000);
  });
});

describe("distanceTo: no location", () => {
  it("is null", () => {
    expect(distanceTo(locate(place("n", "None", [])), 0, 0)).toBeNull();
  });
});

describe("inRegion: bbox region seams", () => {
  const region = (west: number, south: number, east: number, north: number) => ({
    bbox: [west, south, east, north] as [number, number, number, number],
  });

  it.each([
    ["a point at lon 180 in a region with west -180", pointAt(45, 180), region(-180, 40, -170, 50)],
    ["a point at lon -180 in a region with east 180", pointAt(45, -180), region(170, 40, 180, 50)],
    ["a box ending at 180 and a region starting at -180", boxAt(40, 50, 170, 180), region(-180, 40, -170, 50)],
    ["a box starting at -180 and a region ending at 180", boxAt(40, 50, -180, -170), region(170, 40, 180, 50)],
    ["a point at the pole whatever its longitude", pointAt(90, 0), region(10, 80, 20, 90)],
    ["a box reaching the pole at other longitudes", boxAt(85, 90, 100, 110), region(10, 80, 20, 90)],
  ])("keeps %s", (_name, locations, r) => {
    expect(inRegion(locations, r)).toBe(true);
  });

  it.each([
    ["a point just short of the seam", pointAt(45, 179.99), region(-180, 40, -170, 50)],
    ["a box just short of the seam", boxAt(40, 50, 160, 179.99), region(-180, 40, -170, 50)],
    ["a polar box when the region stops short of the pole", boxAt(85, 90, 100, 110), region(10, 80, 20, 89.99)],
  ])("drops %s", (_name, locations, r) => {
    expect(inRegion(locations, r)).toBe(false);
  });
});
