import type { TileRecord } from "./cache.js";
import { locate } from "./merge.js";
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
  const origin = center(region);
  const hits: (SearchHit & { importance: number })[] = [];
  for (const { uri, value } of records) {
    const score = query ? textScore(query, value) : null;
    if (score !== null && score < JW_THRESHOLD) continue;
    const { point } = locate(value);
    hits.push({
      uri,
      place: value,
      distance: point ? haversine(origin.lat, origin.lon, point.lat, point.lon) : null,
      score,
      importance: typeof value.importance === "number" ? value.importance : 0,
    });
  }

  const asc = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);
  const byScore = (a: SearchHit, b: SearchHit) => round3(b.score ?? 0) - round3(a.score ?? 0);
  const byImportance = (a: { importance: number }, b: { importance: number }) => b.importance - a.importance;
  const byDistance = (a: SearchHit, b: SearchHit) => asc(a.distance, b.distance);
  const byUri = (a: SearchHit, b: SearchHit) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
  const order =
    sort === "distance"
      ? [byDistance, byImportance, byScore, byUri]
      : sort === "similarity"
        ? [byScore, byDistance, byUri]
        : [byScore, byImportance, byDistance, byUri];

  hits.sort((a, b) => {
    for (const cmp of order) {
      const d = cmp(a, b);
      if (d) return d;
    }
    return 0;
  });
  return hits.map(({ importance: _, ...hit }) => hit);
}
