import type { TileRecord } from "./cache.js";
import { locate, recordKey } from "./merge.js";
import { normalize } from "./normalize.js";
import { center, haversine } from "./region.js";
import { jaroWinkler } from "./similarity.js";
import type { Region, SearchHit, SortMode } from "./types.js";

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
  const variants = Array.isArray(value.variants) ? (value.variants as { name?: unknown }[]) : [];
  const names = [value.name, ...variants.map((v) => v.name)]
    .filter((n): n is string => typeof n === "string")
    .map(normalize)
    .filter((n) => n !== "");
  return Math.max(0, ...names.map((n) => scoreName(query, tokens, n)));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// `query` is already normalized; "" means no text.
export function rank(records: TileRecord[], region: Region, query: string, sort: SortMode): SearchHit[] {
  const middle = center(region);
  const hits: SearchHit[] = [];
  for (const record of records) {
    const { value } = record;
    const score = query ? textScore(query, value) : null;
    if (score !== null && score < JW_THRESHOLD) continue;
    const { point } = locate(value);
    hits.push({
      origin: recordKey(record),
      place: value,
      importance: record.importance ?? null,
      distance: point ? haversine(middle.lat, middle.lon, point.lat, point.lon) : null,
      score,
    });
  }

  const asc = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);
  const byScore = (a: SearchHit, b: SearchHit) => round3(b.score ?? 0) - round3(a.score ?? 0);
  const byImportance = (a: SearchHit, b: SearchHit) => (b.importance ?? 0) - (a.importance ?? 0);
  const byDistance = (a: SearchHit, b: SearchHit) => asc(a.distance, b.distance);
  const byOrigin = (a: SearchHit, b: SearchHit) =>
    a.origin === b.origin ? 0 : a.origin === null ? 1 : b.origin === null ? -1 : a.origin < b.origin ? -1 : 1;
  const order =
    sort === "distance"
      ? [byDistance, byImportance, byScore, byOrigin]
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
