import type { Region } from "./types.js";

const DEG_TO_M = 111194.927;
const EARTH_RADIUS_M = 6371008.8;
const EPSILON = 1e-9;

export type LonSegment = [number, number];

export function validateRegion(region: Region): void {
  const ok = (n: number, limit: number) => Number.isFinite(n) && Math.abs(n) <= limit;
  if ("bbox" in region) {
    const [minLon, minLat, maxLon, maxLat] = region.bbox;
    if (![minLon, maxLon].every((n) => ok(n, 180)) || ![minLat, maxLat].every((n) => ok(n, 90)) || minLat > maxLat) {
      throw new TypeError("invalid bbox");
    }
  } else if (!ok(region.lat, 90) || !ok(region.lon, 180) || !Number.isFinite(region.radius) || region.radius < 0) {
    throw new TypeError("invalid circle");
  }
}

export function center(region: Region): { lat: number; lon: number } {
  if (!("bbox" in region)) return region;
  const [minLon, minLat, maxLon, maxLat] = region.bbox;
  let lon = minLon <= maxLon ? (minLon + maxLon) / 2 : (minLon + maxLon + 360) / 2;
  if (lon > 180) lon -= 360;
  return { lat: (minLat + maxLat) / 2, lon };
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// A box with minLon > maxLon crosses the antimeridian: two segments.
export function lonSegments(minLon: number, maxLon: number): LonSegment[] {
  return minLon <= maxLon
    ? [[minLon, maxLon]]
    : [
        [minLon, 180],
        [-180, maxLon],
      ];
}

export function lonInSegments(lon: number, segments: LonSegment[]): boolean {
  return segments.some(([lo, hi]) => lon >= lo && lon <= hi);
}

export function lonSegmentsOverlap(a: LonSegment[], b: LonSegment[]): boolean {
  return a.some(([alo, ahi]) => b.some(([blo, bhi]) => alo <= bhi && blo <= ahi));
}

// The circle's enclosing box; minLon > maxLon when it wraps the antimeridian.
function circleBox(lat: number, lon: number, radius: number): [number, number, number, number] {
  const half = radius / DEG_TO_M;
  const minLat = Math.max(lat - half, -90);
  const maxLat = Math.min(lat + half, 90);
  // Half-width of a spherical cap: asin(sin r / cos lat). At or past 1 the cap holds a pole.
  const sinHalfLon = Math.sin((half * Math.PI) / 180) / Math.cos((lat * Math.PI) / 180);
  if (minLat === -90 || maxLat === 90 || !(sinHalfLon < 1)) return [-180, minLat, 180, maxLat];
  const halfLon = (Math.asin(sinHalfLon) * 180) / Math.PI;
  const wrap = (x: number) => (x > 180 ? x - 360 : x < -180 ? x + 360 : x);
  return [wrap(lon - halfLon), minLat, wrap(lon + halfLon), maxLat];
}

const snapDown = (x: number) => {
  const r = Math.round(x * 100);
  return Math.abs(x * 100 - r) < EPSILON ? r : Math.floor(x * 100);
};
const snapUp = (x: number) => {
  const r = Math.round(x * 100);
  return Math.abs(x * 100 - r) < EPSILON ? r : Math.ceil(x * 100);
};

function snapSpan(min: number, max: number, limit: number): [number, number] {
  let lo = snapDown(min);
  let hi = snapUp(max);
  if (lo === hi) {
    if (hi < limit * 100) hi++;
    else lo--;
  }
  return [lo, hi];
}

const fixed = (units: number) => (units / 100).toFixed(2);

// Snapped, serialized getTiles bbox strings (one per antimeridian half), in call order.
export function queryBboxes(region: Region): string[] {
  const [minLon, minLat, maxLon, maxLat] =
    "bbox" in region ? region.bbox : circleBox(region.lat, region.lon, region.radius);
  const [lat0, lat1] = snapSpan(minLat, maxLat, 90);
  return lonSegments(minLon, maxLon).map(([lo, hi]) => {
    const [lon0, lon1] = snapSpan(lo, hi, 180);
    return [lon0, lat0, lon1, lat1].map(fixed).join(",");
  });
}
