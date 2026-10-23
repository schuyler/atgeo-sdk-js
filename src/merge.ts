import type { TileRecord } from "./cache.js";
import {
  haversine,
  lonInSegments,
  lonSegments,
  lonSegmentsOverlap,
  type LonSegment,
} from "./region.js";
import type { PlaceValue, Region } from "./types.js";
import { isObject } from "./wire.js";

export interface Locations {
  point: { lat: number; lon: number } | null;
  bbox: { south: number; north: number; segments: LonSegment[] } | null;
}

export function locate(value: PlaceValue): Locations {
  const result: Locations = { point: null, bbox: null };
  const locations: unknown[] = Array.isArray(value.locations) ? value.locations : [];
  for (const loc of locations) {
    if (!isObject(loc)) continue;
    // A coordinate is a string or a number; anything else, a one-element array included, does not parse.
    const num = (key: string) => (typeof loc[key] === "string" || typeof loc[key] === "number" ? parseFloat(String(loc[key])) : NaN);
    if (loc.$type === "community.lexicon.location.geo" && !result.point) {
      const lat = num("latitude");
      const lon = num("longitude");
      if (Number.isFinite(lat) && Number.isFinite(lon)) result.point = { lat, lon };
    } else if (loc.$type === "community.lexicon.location.bbox" && !result.bbox) {
      const [south, north, west, east] = [num("south"), num("north"), num("west"), num("east")];
      if ([south, north, west, east].every(Number.isFinite)) {
        result.bbox = { south, north, segments: lonSegments(west, east) };
      }
    }
  }
  return result;
}

export function recordKey(r: TileRecord): string | null {
  return typeof r.value.origin === "string" ? r.value.origin : (r.uri ?? null);
}

// Keeps the first copy of each key, in the order given. Records without a key can't be told apart, so all pass.
export function dedupe(records: TileRecord[]): TileRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = recordKey(r);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const angularGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

function nearestLon(lon: number, segments: LonSegment[]): number {
  if (lonInSegments(lon, segments)) return lon;
  const ends = segments.flat();
  return ends.reduce((best, e) => (angularGap(e, lon) < angularGap(best, lon) ? e : best));
}

// ±180 are one meridian, and every meridian meets at a pole.
function covers(south: number, north: number, segments: LonSegment[], lat: number, lon: number): boolean {
  if (lat < south || lat > north) return false;
  return (
    Math.abs(lat) === 90 ||
    lonInSegments(lon, segments) ||
    (Math.abs(lon) === 180 && lonInSegments(-lon, segments))
  );
}

// The box-to-box form of covers(): boxes touching ±180 meet at the seam, and boxes reaching a pole meet there.
function meets(box: NonNullable<Locations["bbox"]>, south: number, north: number, segments: LonSegment[]): boolean {
  const lo = Math.max(box.south, south);
  const hi = Math.min(box.north, north);
  if (lo > hi) return false;
  const twins = box.segments.flatMap((s): LonSegment[] => [
    s,
    ...(s[1] === 180 ? [[-180, -180] as LonSegment] : []),
    ...(s[0] === -180 ? [[180, 180] as LonSegment] : []),
  ]);
  return hi === 90 || lo === -90 || lonSegmentsOverlap(twins, segments);
}

// Meters from (lat, lon) to the nearest point of the place; null if it has no location.
// Containment is tested explicitly so it yields exactly 0 rather than trig round-trip noise.
export function distanceTo(locations: Locations, lat: number, lon: number): number | null {
  const { point, bbox } = locations;
  const contained = point
    ? covers(point.lat, point.lat, [[point.lon, point.lon]], lat, lon)
    : bbox && covers(bbox.south, bbox.north, bbox.segments, lat, lon);
  if (contained) return 0;
  if (point) return haversine(lat, lon, point.lat, point.lon);
  if (!bbox) return null;
  // Along the nearest meridian, cos(d) = R cos(phi - phiC); phiC is where that meridian comes closest.
  const lonStar = nearestLon(lon, bbox.segments);
  const phi0 = (lat * Math.PI) / 180;
  const dLon = (angularGap(lonStar, lon) * Math.PI) / 180;
  const phiC = (Math.atan2(Math.sin(phi0), Math.cos(phi0) * Math.cos(dLon)) * 180) / Math.PI;
  return Math.min(
    haversine(lat, lon, Math.min(Math.max(phiC, bbox.south), bbox.north), lonStar),
    haversine(lat, lon, bbox.south, lonStar),
    haversine(lat, lon, bbox.north, lonStar),
  );
}

export function inRegion(locations: Locations, region: Region): boolean {
  const { point, bbox } = locations;
  if ("bbox" in region) {
    const [minLon, minLat, maxLon, maxLat] = region.bbox;
    const segments = lonSegments(minLon, maxLon);
    if (point) return covers(minLat, maxLat, segments, point.lat, point.lon);
    return !!bbox && meets(bbox, minLat, maxLat, segments);
  }
  const d = distanceTo(locations, region.lat, region.lon);
  return d !== null && d <= region.radius;
}
