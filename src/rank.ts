import type { TileRecord } from "./cache.js";
import { distanceTo, locate, recordKey, type Locations } from "./merge.js";
import { normalize } from "./normalize.js";
import { center } from "./region.js";
import { jaroWinkler } from "./similarity.js";
import type { Region, SearchHit, SortMode } from "./types.js";
import { isObject } from "./wire.js";

const JW_THRESHOLD = 0.6;
const MAX_QUERY_TOKENS = 12;

function scoreName(query: string, tokens: string[], name: string): number {
  const nameTokens = name.split(" ");
  const tokenScore =
    tokens.reduce((sum, t) => sum + Math.max(...nameTokens.map((n) => jaroWinkler(t, n))), 0) / tokens.length;
  return 0.5 * jaroWinkler(query, name) + 0.5 * tokenScore;
}

function textScore(query: string, value: TileRecord["value"]): number {
  const tokens = query.split(" ").slice(0, MAX_QUERY_TOKENS);
  const variants: unknown[] = Array.isArray(value.variants) ? value.variants : [];
  const names = [value.name, ...variants.map((v) => (isObject(v) ? v.name : undefined))]
    .filter((n): n is string => typeof n === "string")
    .map(normalize)
    .filter((n) => n !== "");
  return Math.max(0, ...names.map((n) => scoreName(query, tokens, n)));
}

// Relative spherical area; a point is 0, so it ranks before any box containing it.
function specificity({ point, bbox }: Locations): number {
  if (point || !bbox) return 0;
  const rad = Math.PI / 180;
  const width = bbox.segments.reduce((sum, [lo, hi]) => sum + (hi - lo) * rad, 0);
  return (Math.sin(bbox.north * rad) - Math.sin(bbox.south * rad)) * width;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// `query` is already normalized; "" means no text.
export function rank(records: TileRecord[], region: Region, query: string, sort: SortMode): SearchHit[] {
  const middle = center(region);
  const hits: SearchHit[] = [];
  const area = new Map<SearchHit, number>();
  for (const record of records) {
    const { value } = record;
    const score = query ? textScore(query, value) : null;
    if (score !== null && score < JW_THRESHOLD) continue;
    const locations = locate(value);
    const hit = {
      origin: recordKey(record),
      place: value,
      importance: record.importance ?? null,
      // rank only receives records that passed inRegion, which requires a location.
      distance: distanceTo(locations, middle.lat, middle.lon)!,
      score,
    };
    hits.push(hit);
    area.set(hit, specificity(locations));
  }

  const byScore = (a: SearchHit, b: SearchHit) => round3(b.score ?? 0) - round3(a.score ?? 0);
  const byImportance = (a: SearchHit, b: SearchHit) => (b.importance ?? 0) - (a.importance ?? 0);
  const byDistance = (a: SearchHit, b: SearchHit) => a.distance - b.distance;
  const bySpecificity = (a: SearchHit, b: SearchHit) => area.get(a)! - area.get(b)!;
  const byOrigin = (a: SearchHit, b: SearchHit) =>
    a.origin === b.origin ? 0 : a.origin === null ? 1 : b.origin === null ? -1 : a.origin < b.origin ? -1 : 1;
  const order =
    sort === "distance"
      ? [byDistance, bySpecificity, byImportance, byScore, byOrigin]
      : sort === "similarity"
        ? [byScore, byDistance, byOrigin]
        : [byScore, byImportance, byDistance, byOrigin];

  hits.sort((a, b) => {
    for (const cmp of order) {
      const d = cmp(a, b);
      if (d) return d;
    }
    return 0;
  });
  return hits;
}
