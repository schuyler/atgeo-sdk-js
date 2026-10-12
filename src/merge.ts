import type { TileRecord } from "./cache.js";
import {
  haversine,
  lonInSegments,
  lonSegments,
  lonSegmentsOverlap,
  type LonSegment,
} from "./region.js";
import type { PlaceValue, Region } from "./types.js";

export interface Locations {
  point: { lat: number; lon: number } | null;
  bbox: { south: number; north: number; segments: LonSegment[] } | null;
}

export function locate(value: PlaceValue): Locations {
  const result: Locations = { point: null, bbox: null };
  const locations = Array.isArray(value.locations) ? (value.locations as Record<string, unknown>[]) : [];
  for (const loc of locations) {
    const num = (key: string) => parseFloat(String(loc[key]));
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

// Keeps the first copy of each rkey, in the order given.
export function dedupe(records: TileRecord[]): TileRecord[] {
  const seen = new Set<unknown>();
  return records.filter((r) => {
    if (seen.has(r.value.rkey)) return false;
    seen.add(r.value.rkey);
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

export function inRegion(locations: Locations, region: Region): boolean {
  const { point, bbox } = locations;
  if ("bbox" in region) {
    const [minLon, minLat, maxLon, maxLat] = region.bbox;
    const segments = lonSegments(minLon, maxLon);
    if (point) {
      return point.lat >= minLat && point.lat <= maxLat && lonInSegments(point.lon, segments);
    }
    return !!bbox && bbox.south <= maxLat && bbox.north >= minLat && lonSegmentsOverlap(bbox.segments, segments);
  }
  if (point) return haversine(region.lat, region.lon, point.lat, point.lon) <= region.radius;
  if (!bbox) return false;
  const lat = Math.min(Math.max(region.lat, bbox.south), bbox.north);
  return haversine(region.lat, region.lon, lat, nearestLon(region.lon, bbox.segments)) <= region.radius;
}
