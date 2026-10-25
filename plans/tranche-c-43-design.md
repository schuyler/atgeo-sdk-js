# Tranche C (atgeo-sdk-js #43): design

Status: DRAFT for review. Inputs: `tranche-c-43-requirements.md` (approved), decision comments on
atgeo-sdk-js #30, #32 and garganorn #14, #15, #16, #19, port ticket atgeo-sdk-python #8.
"GUESS" marks anything not settled by those inputs. "DECISION" marks a choice this design makes that
the inputs leave open; a reviewer should accept or overturn each.

## 0. Approved requirements (restated)

Outcome 10 (S): the `docs/port-contract.md` revision, implemented in the TypeScript reference (`src/`).

| # | Source | Outcome |
|---|---|---|
| R1 | #32 | `dataset` is required on search, with no default. Delete the two §4.1 rows for an absent dataset. A dataset with no collection searches the whole dataset. A missing dataset is an argument error raised before any request. In TS that means a required property in the type and a runtime throw for JS callers. The README passes `dataset` explicitly. "Server requirements" drops the overturemaps.org/place assumption. |
| R2 | #30 | `SearchResult.attribution` is the union of every loaded tile's `attribution` entries, deduped by (dataset, collection), reference entries included, sorted by (dataset, collection) in ordinal order. `SearchHit.collection: {dataset, collection} \| null` comes from a prefix match of the origin against `urn:atgeo:{dataset}:{collection}:` for each entry in the tile's attribution. No URN parsing; it reuses the §4.7 test; no match gives null. The tile cache keeps each tile's attribution (§4.4, §10). `describeTileset` stays uncached. |
| R3 | garganorn#15 | The getPlace transport reads `{ uri, url, importance?, value, attribution }`. `PlaceRecord` exposes `attribution`. The public API keeps `origin` and `place`. The contract adds one sentence: SDK `origin` is the wire record key (the `uri` param and response), and SDK `place` is wire `value`. |
| R4 | garganorn#14 | §4.1 and §8 get a note: dataset-only ranking across tilesets is sound under the revised spec wording. No behaviour change. |
| R5 | garganorn#16 | Port specs and the README name the bbox region fields `west`, `south`, `east`, `north`. The wire order is unchanged. |
| R6 | garganorn#19 | §9: describeService and describeTileset pass through `maxTiles` and `overview: { records }` leniently. |
| R7 | — | Fixtures cover attribution, the new getPlace shape, and lenient-reader cases for the new describe fields. |
| R8 | — | Update the contract's pinned reference commit. After merge, the port tickets get the merge commit. |
| Accept | | The TS unit suite and the updated fixtures pass. `npm run typecheck` passes (the repo has no separate lint script; typecheck is the lint gate). |
| Out | | #31 and #33, unless they fall out. |
| Process | | TDD red to green (vitest). test/lexicon is re-vendored at the garganorn main commit where tranche B lands, before C's PR merges. |

## 1. Contract changes (docs/port-contract.md)

Draft wording follows. Section numbers are the current ones; one new subsection is added (§4.10).

**Header, line 5 (R8).** See §7 below. The text changes either way.

**§1 table / list.**
- tile payload line becomes: "tile payload (`org.atgeo.tilePayload`) → `{ records: [{ value, uri?, importance? }], attribution?, publishedAt? }`. Only `value`, `uri` and `importance` are kept per record. Of the payload, `attribution` is kept (below) and `publishedAt` is ignored. …(rest unchanged)"
- getPlace line becomes: "`getPlace` → `{ uri, url, importance?, value, attribution }`. `value` must be an object, or the response has no usable body. `importance` is read as for a tile record and `attribution` as below. `uri` and `url` are not read."
- describeService line becomes: "`describeService` → `{ did, maxTiles?, tilesets: [{ slug, collections: [{ dataset, collection }] }] }`."
- describeTileset line stays (`org.atgeo.defs#tileset`, which now has an optional `overview: { records }`).
- New paragraph after the describe-leniency paragraph:
  > An `attribution` list, in a tile payload or a `getPlace` response, holds `org.atgeo.defs#collectionAttribution` entries. In a tile payload it is optional: absent unless it is an array. In `getPlace`, which requires it, it is empty unless it is an array. An element is kept only if it is an object whose `dataset` and `collection` are both strings. Anything else is dropped, since an entry without both can't be credited to a collection. In a kept entry, `release`, `source` and `attribution` are strings or absent, and `licenses` is the string elements of an array, or absent. Each field is read on its own, and other fields are ignored. Entries keep their served order, duplicates included. A search merges them (section 4.10); `getPlace` surfaces them as read (section 9).

  DECISION: drop entries that lack either key. This is stricter than the describeTileset `references` reader, which keeps `{dataset}` alone. It is still lenient, because a compliant server never sends such an entry, and it gives apps non-optional `dataset`/`collection`.
- Line 37: "`value`, in a tile record and in a `getPlace` response, is an `org.atgeo.place` value and must be surfaced to the caller unmodified: …"
- Line 39, last sentence: "The same reading applies to `recordCount` in a collection, `count` in a category, `maxTiles` in describeService, and `records` in a tileset's `overview`."
- Errors, line 47 "no usable body" list: "a `getPlace` body with no `value` object" (it was `record`). Note in passing: "A body in the earlier shape, with `record` and no `value`, has no usable body."

**§3 Regions, first sentence (R5).**
> A region is a circle `{ lat, lon, radius }` (radius in metres) or a bounding box `[west, south, east, north]` in degrees. The port specs and READMEs use those names. Below, `minLon`, `minLat`, `maxLon`, `maxLat` name the same four values in the same order, which is also the order of the `getTiles` bbox string.

The §3 and §6 algorithm text keeps `minLon` etc. unchanged; the doc has too many formulas to rename them all.

**§3 Validation (R1).** A new first bullet: "a search with no `dataset` (section 4.1);". It goes first so that a port whose language makes it a call-site error (a required keyword or parameter) agrees with one that checks at run time.

**§4 header.** `searchPlaces(region, dataset, text?, collection?, sort?)`. In the TS options object, order doesn't matter.

**§4.1 (R1, R4).** Replace the table with:
> `dataset` is required and has no default. A search without one is an argument error, raised before any request (section 3), in the port's idiom: a required parameter, a non-optional type, or a check that throws the port's argument-error type. A dynamically typed port treats a `dataset` that is not a string as missing. An empty string is a string and goes to the server. With a `collection` the search covers that collection. Without one it covers the whole dataset, with no collection filter. A `collection` given without a `dataset` is the same argument error.
>
> A dataset-only search merges every tileset the server serves for the dataset and ranks them together by importance (section 8). That is sound: the atgeo spec defines importance as comparable across the tilesets one producer builds from one dataset (garganorn `docs/atgeo-spec.md`, "Importance"; schuyler/garganorn#14).

The `collection` query parameter sentence stays.

DECISION: an empty-string dataset is not an argument error; it is sent as given. Rationale:
- #32 asks only that a *missing* dataset be an error.
- A typed port's `String` can't tell `""` from a real name without an extra rule no input asks for.
- The server is the authority on which datasets exist (it answers `DatasetNotFound` or `InvalidRequest`).
- It matches the Python spec's existing remark that `dataset=""` is a dataset, sent as given.

**§4.4.** In the second bullet, "keep `{ value, uri?, importance? }` per usable record" becomes "keep `{ value, uri?, importance? }` per usable record and the payload's `attribution` (section 1)". After "store the tile in the cache", add "with its size and attribution (section 10)". The attribution is read inside the guarded decode step. A malformed `attribution` never fails a tile, since it only drops entries.

**New §4.10 Attribution (R2).** Placed after §4.9, with §4.9's result shape extended to `{ places, complete, overview, tiles, tileFailures, attribution }`.
> The result's `attribution` credits every collection whose data the search's tiles hold. It is built from every tile the search used (4.4), from the cache or the network, whether or not any of the tile's records survived 4.6 to 4.9. A failed tile contributes nothing. Walk the used tiles in URL order (4.3), and each tile's entries in served order, and keep the first entry for each `(dataset, collection)` pair, compared as exact strings. Then sort by `dataset`, then `collection`, each in the ordinal order of 4.3. `attribution` is always present on a result, never absent or null. It is an empty list when no tile was used, or when no used tile has an attribution (a tile without one counts as an empty list).
>
> Reference entries are included: a tileset's entries for collections it doesn't carry but whose data its records include. A hit's `within` relations carry a containing division's name, so an app that shows the hit shows that collection's data too. A tile's entries don't say which are references, and the client doesn't ask.
>
> Each entry is surfaced with the fields section 1 kept. The app may change what it is given without changing the cache: a port either hands out immutable values or copies them.

DECISION: when two tiles' entries for one pair differ (a release, say), the lowest tile URL wins, the same rule as record dedupe. A tile doesn't mark references, so "prefer the carrier" isn't possible. A duplicate pair within one tile: the first wins.

**§8 hit table (R2).** A new row after `origin`:

| `collection` | a new object holding exactly `{ dataset, collection }` (no other field of the entry, and not the entry itself) of the first entry, in served order, of the `attribution` of the tile the record came from (the tile whose copy 4.6 kept). The entry is the first one for which `value.origin` is a string starting with `urn:atgeo:{dataset}:{collection}:`, the test of 4.7. It is null when no entry matches, when the tile has no attribution, or when `value.origin` is not a string (a record keyed by its `uri`). The origin is never split. A tile without an attribution counts as an empty list here. `collection` is always present on a hit: an object or null, never absent. |

DECISION: match on `value.origin`, not on the hit's `origin` (which falls back to `uri`), exactly as §4.7 does. A collection-filtered search whose tile doesn't list the searched pair gets null hits, not the searched pair. That is consistent with "no match gives null", and garganorn tiles always list it.

**§8, after byImportance (R4).** "Importance is comparable across one producer's tilesets for one dataset (section 4.1), which makes this comparator sound for a dataset-only search."

**§8, ranking fixture sentence.** "…run the records through sections 4.6 to 4.9 as a search of the scenario's `dataset` and `collection` (no network)…" (see §5, ranking-scenarios).

**§9 (R3, R6).**
- New first paragraph:
  > The SDK's `origin` is the wire's record key: the `uri` parameter of `getPlace`, which its response echoes as `uri`. The SDK's `place` is the wire's `value`, in a tile record and in a `getPlace` response alike.
- getPlace paragraph: a hit returns `{ origin, place: value, importance ?? null, attribution }`, where `attribution` is the source tile's `attribution` as read (section 1), or empty when the tile has none (absent, or not an array). That tile is the lowest-URL one holding the record. A miss returns `{ origin, place: value, importance ?? null, attribution }`, where `attribution` is the response's `attribution` as read (section 1). Neither is merged or sorted: it keeps served order, duplicates included. On both paths `attribution` is always a list, never absent or null. Draft sentence: "For garganorn the two agree, since `getPlace` answers with the attribution of the place's tileset, which is the list every tile of that tileset carries." (Settled by the main agent: garganorn#15 says ports change only their transport layer.)
- New sentence after the getPlace paragraph, mirroring the `place` paragraph:
  > `attribution` in a `getPlace` answer, from the cache or the network, and in a search result (4.10) is the app's own. A port either hands out immutable values or copies them, so an app that changes an entry or its `licenses` list changes neither the cached tile nor a later search's or `getPlace`'s answer. The reference copies each entry and its `licenses` array per answer.
- describeService: "Cached for one hour; otherwise one request. Returned as decoded, leniently (section 1). That includes `maxTiles`, the server's tile budget. It is informational: tile zooms are adaptive, so a client can't tell from it whether a box fits."
- describeTileset: "…including `overview`. It is absent when the tileset has no overview band, or when the field is not an object. When present it is an object whose `records`, the number of records in the band, is read as in section 1 and is absent when unreadable. Unknown fields in it are ignored. Never cached."

**§10.** The Tiles bullet: "Tiles: keyed by URL, each holding its usable records and its `attribution` (section 1), so a warm search (4.10) and the getPlace scan (section 9) have it without a request. …" Add after the memo sentence: "A port that holds bodies and parses them again parses the attribution again too." No size change: a tile's size is still its body length, and the attribution is part of the body.

**§12.** No change. Attribution adds no request, and getPlace still sends only `uri`.

**§13.** The fixture list gains `fixtures/attribution-scenarios.json` (N scenarios, exact match; §5). Its runner text includes the fresh-client-per-scenario rule (§5). The lenient-readers count is updated to the final number. The ranking line notes the new `dataset`/`collection` fields. Test list: `client.test.ts` "…describe calls, result shapes, the required dataset, attribution and hit collections", and a new line for `attribution.test.ts`.

## 2. TS type and API changes (src/)

`src/types.ts`:
```ts
export interface CollectionKey { dataset: string; collection: string }          // new
export interface Attribution extends CollectionKey {                           // new
  release?: string; source?: string; licenses?: string[]; attribution?: string;
}
export interface PlaceRecord { origin: string; place: PlaceValue; importance: number | null; attribution: Attribution[] }
export interface ServiceDescription { did?: string; maxTiles?: number; tilesets: {...}[] }
export interface Tileset { ...; overview?: { records?: number } }
export type Region =
  | { lat: number; lon: number; radius: number }
  | { bbox: [west: number, south: number, east: number, north: number] };   // labelled tuple, same order (R5)
export interface SearchOptions { dataset: string; collection?: string; region: Region; text?: string; sort?: SortMode; signal?: AbortSignal }
export interface SearchHit { origin: string | null; collection: CollectionKey | null; place; importance; distance; score }
export interface SearchResult { places; complete; overview; tiles; tileFailures; attribution: Attribution[] }
```
The existing `CollectionAttribution` (lenient, optional keys) stays for describeTileset. `index.ts` already does `export type *`.

`src/wire.ts`:
```ts
export function readAttributionList(v: unknown): Attribution[] | undefined   // the section 1 rule; absent unless an array
export function readTilePayload(body: unknown): { records: TileRecord[]; attribution?: Attribution[] }
export function readPlace(body: unknown): { value: PlaceValue; importance?: number; attribution: Attribution[] }  // value frozen; attribution ?? []
// readServiceDescription: + maxTiles: readInteger(body.maxTiles)
// readTileset: + overview: isObject(o) ? present({ records: readInteger(o.records) }) : undefined
```
Every entry goes through `present()`, so an absent field is a missing key (strict fixture equality). Update the `DecodingError` doc comment (`value`, not `record`).

New `src/attribution.ts` (pure, no imports beyond types):
```ts
export const collectionPrefix = (dataset: string, collection: string) => `urn:atgeo:${dataset}:${collection}:`;
export const inCollection = (value: PlaceValue, prefix: string) =>
  typeof value.origin === "string" && value.origin.startsWith(prefix);              // the section 4.7 test, now shared
export function collectionOf(value: PlaceValue, attribution: readonly Attribution[] | undefined): CollectionKey | null;
// returns a new { dataset, collection } built from the matching entry's two keys, never the entry itself
export function mergeAttribution(lists: readonly (readonly Attribution[] | undefined)[]): Attribution[];  // search only
export function copyAttribution(list: readonly Attribution[]): Attribution[];   // fresh objects, order and duplicates kept
```
`mergeAttribution`: keep the first entry per pair using a nested `Map<string, Map<string, Attribution>>` or a `JSON.stringify([d, c])` key, never `` `${d}|${c}` ``. Then sort with `(a, b) => cmp(a.dataset, b.dataset) || cmp(a.collection, b.collection)`, where `cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0)`, never `localeCompare`. Return fresh objects (`{ ...e, ...(e.licenses && { licenses: [...e.licenses] }) }`).

`src/cache.ts`: `export interface TileEntry { records: TileRecord[]; attribution?: Attribution[]; size: number }`. `find(key)` returns `{ record: TileRecord; attribution?: Attribution[] } | undefined`, with the same lowest-URL rule and no recency touch. No format or version bump: the cache is in memory only, never persisted, never shared, and a client starts cold. Tile URLs change to `.json` server-side anyway.

`src/merge.ts`: `dedupe` becomes generic over the carrier:
`export function dedupe<T extends { record: TileRecord }>(items: T[]): T[]` (key = `recordKey(item.record)`).

`src/rank.ts`: `rank(items: { record: TileRecord; attribution?: Attribution[] }[], region, query, sort)`. Each hit gets `collection: collectionOf(record.value, attribution)`, computed after the text threshold.

`src/client.ts` search, after the fetch loop (`loaded: Map<string, { records; attribution? }>`):
```ts
const used = urls.filter((u) => loaded.has(u));                                   // URL order
const attribution = mergeAttribution(used.map((u) => loaded.get(u)!.attribution));
const prefix = collection === undefined ? undefined : collectionPrefix(dataset, collection);
const items = dedupe(used.flatMap((u) => { const t = loaded.get(u)!; return t.records.map((record) => ({ record, attribution: t.attribution })); }))
  .filter(({ record }) => prefix === undefined || inCollection(record.value, prefix))
  .filter(({ record }) => inRegion(locate(record.value), region));
return { places: rank(items, region, query, sort), complete, overview, tiles, tileFailures, attribution };
```
The cache store becomes `this.tiles.set(url, { records, attribution, size })` (still unguarded). `fetchTile` returns `{ records, attribution?, size } | TileFailure`.

`searchPlaces`, first line (R1), before `validateRegion`:
```ts
if (typeof (options as { dataset?: unknown }).dataset !== "string") throw new TypeError("searchPlaces requires a dataset");
```
Delete `DEFAULT_DATASET`/`DEFAULT_COLLECTION`. In `search()`: `const { dataset, collection } = options;`.

`getPlace`: cache hit returns `{ origin, place: hit.record.value, importance: hit.record.importance ?? null, attribution: copyAttribution(hit.attribution ?? []) }`. A miss returns `{ origin, place: value, importance: importance ?? null, attribution }`, with the reader's list as served. `copyAttribution` (in `attribution.ts`) maps each entry to a fresh object, `licenses` array included, without dedupe or sort. It exists so an app can't change the cache, and `mergeAttribution` uses it too.

`describeService`/`describeTileset`: code unchanged (the readers carry the new fields). describeTileset stays uncached.

## 3. Fake server (test/helpers/fakeServer.ts)

These changes depend on the re-vendored lexicons (§6), because the fake validates its own output.
- `getPlaceAnswer` returns `{ uri: origin, url: `${server}/${dataset}/${collection}/${id}`, importance?, value: found.value, attribution: <tileBody attribution of that tileset> }`.
- describeService always sends the constant `maxTiles: 50` (garganorn's default), which validates whether B makes it required or optional. There is no option for it.
- `FakeTileset.overview?: { records: number }`, emitted by `descriptorOf`.
- `tileBody` is unchanged (it already emits collections plus references as `attribution`).
- If B adds a lexicon file that another references, import it into `lexicons`.

## 4. Lenient pass-through of maxTiles / overview

Covered by §1 (§9 text), §2 (readers) and §5 (fixture cases). `maxTiles` and `overview.records` use `readInteger`: truncated toward zero, absent if non-number or |x| ≥ 2^63, and negatives kept. An `overview` that is an object with unreadable `records` is `{}`, following the `extent` precedent. A non-object `overview` (array, null, number, string) is absent.

## 5. Fixtures (the executable contract for four ports)

**fixtures/lenient-readers.json.** The case schema (`reader`, `name`, `body`, `result` | `decodingError`) is unchanged.
- `tilePayload`: the result schema changes from an array of records to an object `{ "records": [...], "attribution"?: [...] }`. That is breaking for port runners, which change one mapping function. All 15 non-error cases are rewrapped `{ "records": <old result> }`, except "a usable record keeps value, uri and importance", whose body has `"attribution": []` and whose result gains `"attribution": []`. The 7 decodingError cases are unchanged. New cases:
  - "attribution entries are read leniently": `{"records":[],"attribution":[null,5,"x",[],{},{"dataset":"d"},{"collection":"c"},{"dataset":1,"collection":"c"},{"dataset":"d","collection":"c","release":"r","source":"s","licenses":["l",1,null],"attribution":"a","extra":1},{"dataset":"d","collection":"c","release":5,"licenses":"l"}]}` → `{"records":[],"attribution":[{"dataset":"d","collection":"c","release":"r","source":"s","licenses":["l"],"attribution":"a"},{"dataset":"d","collection":"c"}]}`. This pins that the reader drops unkeyed entries, keeps duplicates and keeps served order.
  - "attribution that is not an array is absent": `{"records":[],"attribution":{}}` → `{"records":[]}`, and the same for `null`.
- `getPlace`: every existing body and result uses `value` in place of `record`. Every non-error result gains `"attribution": []`. Case names change from "record" to "value" (e.g. "no usable body: no value"). New cases:
  - "the full answer": `{"uri":"urn:atgeo:d:c:1","url":"https://x.example/d/c/1","importance":5,"value":{"name":"A","extra":[1]},"attribution":[{"dataset":"d","collection":"c","licenses":["l"]}]}` → `{"value":{"name":"A","extra":[1]},"importance":5,"attribution":[{"dataset":"d","collection":"c","licenses":["l"]}]}`.
  - "no usable body: the earlier shape, record and no value": `{"uri":"x","record":{}}` → decodingError.
  - "attribution is read leniently": `{"value":{},"attribution":[null,{"dataset":"d"},{"dataset":"d","collection":"c","licenses":"l"}]}` → `{"value":{},"attribution":[{"dataset":"d","collection":"c"}]}`.
  - "attribution that is not an array is empty": `{"value":{},"attribution":"x"}` → `{"value":{},"attribution":[]}`.
  - "attribution keeps served order and duplicates": `{"value":{},"attribution":[{"dataset":"z","collection":"c"},{"dataset":"a","collection":"c","release":"1"},{"dataset":"a","collection":"c","release":"2"}]}` → the same three entries in the same order.
- `describeService`: "a full answer" body and result gain `"maxTiles": 50`. New: "a fractional maxTiles is truncated toward zero" (50.9 → 50); "a maxTiles that is not a number is absent" (`"50"`); "maxTiles out of range is absent" (`1e30`); "a negative maxTiles is kept" (`-5` → `-5`).
- `describeTileset`: "a full answer" body and result gain `"overview": {"records": 10000}`. New: "an overview's records is read as an integer and unknown fields are ignored" (`{"overview":{"records":2.9,"zooms":[1]}}` → `{"collections":[],"overview":{"records":2}}`); "an overview with unreadable records is an empty overview" (`{"overview":{"records":"10"}}` → `{"collections":[],"overview":{}}`); "an overview that is not an object is absent" (`{"overview":[{"records":1}]}` → `{"collections":[]}`); "an overview that is null is absent" (`{"overview":null}` → `{"collections":[]}`).
- That makes 88 + 3 + 5 + 4 + 4 = **104 cases**, if "not an array" for tilePayload is two cases. Recount when written and put the real number in §13.

**fixtures/attribution-scenarios.json (new).** A JSON array of scenarios:
```jsonc
{
  "name": "string", "description": "string",
  "dataset": "string", "collection": "string",        // collection optional
  "region": { "lat", "lon", "radius" } | { "bbox": [west, south, east, north] },
  "tiles": [ { "url": "https://places.atgeo.org/tiles/b.json",
               "body": <any JSON>,                        // optional; served verbatim
               "status": 500 } ],                         // optional; default 200
  "expect": {
    "attribution": [ <entries, exact, in order> ],
    "hits": [ { "origin": "string|null", "collection": { "dataset", "collection" } | null } ]
  }
}
```
Runner contract (§13 text): use a fresh client per scenario. Scenarios reuse tile URLs (`a.json`, `b.json`) with different bodies, and the tile-list cache key is `{dataset}|{collection}|{bbox}`, so a shared client would serve one scenario's cached lists and tiles to the next ("no tiles" especially). The base server is `https://places.atgeo.org`. The raw server routes `https://places.atgeo.org/xrpc/org.atgeo.getTiles` (any query) separately from the absolute tile URLs, which it matches exactly. It answers every `getTiles` call with `{ "tiles": [the urls in listed order] }`. Listed order is deliberately not sorted, which exercises 4.3. Serve each tile's `body` verbatim with its `status` (default 200). A tile with a `status` and no `body` gets the body `{"error":"InternalServerError","message":"upstream error"}`, which makes it a failed tile of kind `status`. A 200 tile whose body is not a usable payload is a failed tile of kind `decode`. The bodies need not validate against the lexicons, so use a raw server and not a validating fake. Search with no text and the default sort. Assert `attribution` deep-equal including order, with an absent field as a missing key. Assert the hits as a multiset of `(origin, collection)` pairs equal to `expect.hits`, order-insensitive. Every hit must carry the `collection` key; a null is `null`, never a missing key. Each `collection` is compared with strict equality (TS `toStrictEqual`), so a port that hands back the whole entry, with `release` or `licenses`, fails. The scenarios' entries carry those extra fields on purpose. Scenarios (12):
1. "reference entries are included": one tile with `overturemaps.org/place` (with `release`, `licenses`, `source`, `attribution`) and the reference `overturemaps.org/division`, and one place hit. Expect both entries, division first, and the hit's collection `place`.
2. "deduped by pair, lowest tile URL wins": tiles listed `b`, `a` with the same pair and different `release`. Expect `a`'s release. Entries only in `b` are included.
3. "sorted by dataset then collection, ordinal": entries `openstreetmap.org/way`, `openstreetmap.org/node`, `Example.org/x`, `example.org/x`, `openstreetmap.org/wayside`, served unsorted. Also the `|`-join trap pair `{dataset:"a|b", collection:"c"}` and `{dataset:"a", collection:"b|c"}`, which a `|`-joined key would merge. Expect all seven entries:
   - `Example.org` before `example.org` (ordinal, not locale);
   - `way` before `wayside`;
   - `a` / `b|c` before `a|b` / `c`.
4. "a tile whose records all fall outside the region still contributes".
5. "a failed tile contributes nothing": two failed tiles.
   - A 200 tile with body `{"records":"x","attribution":[{"dataset":"leak.example","collection":"c"}]}`. It fails decode but carries readable attribution, which kills an implementation that reads attribution before validating `records`.
   - A `status: 500` tile.

   One good tile with its own entry. `expect.attribution` holds only the good tile's entry, never `leak.example`.
6. "the collection is a prefix match, not a split": dataset-only OSM search; entries `way` and `wayside`; origins `…:way:2` → way, `…:wayside:9` → wayside; an origin `urn:atgeo:example.org:thing:1` with no entry → null; a uri-keyed record with no origin whose `uri` is `urn:atgeo:openstreetmap.org:way:77` → null (pins matching on `value.origin`, not the key's `uri` fallback).
7. "the kept copy's tile decides the collection": the same origin in `a.json` (attribution lacking its pair) and `b.json` (with it). The hit's collection is null, and the union still has `b`'s entry.
8. "absent and unusable attribution": one tile without `attribution` and one whose entries lack `collection`. Expect an empty attribution and null collections.
9. "a duplicate pair within one tile: the first wins": the two entries for one pair differ in `release` (`"1"` then `"2"`); expect `release: "1"`.
10. "no tiles": `tiles: []`. Expect `attribution: []` and `hits: []`.
11. "two entries give the same prefix: the first in served order wins": entries served `{dataset:"a:b", collection:"c"}` first, then `{dataset:"a", collection:"b:c"}`. Origin `urn:atgeo:a:b:c:1`, dataset-only search of `a`.
    - The hit's collection is `{dataset:"a:b", collection:"c"}`. Sorted order would put `{a, b:c}` first, so this kills sort-before-match.
    - `attribution` is sorted `[{a, b:c, …}, {a:b, c, …}]`, both kept, which kills a `:`-joined pair key.
12. "a collection-filtered search whose tile lacks the pair": a search of `openstreetmap.org` / `way` whose tile lists only `openstreetmap.org/node`; a `…:way:2` hit passes the 4.7 filter and has collection null.

**fixtures/ranking-scenarios.json.** Add `"dataset": "overturemaps.org", "collection": "place"` after `"region"` in each of the 12 scenarios (every origin is in that collection). Runners pass them. Nothing else changes.

normalize.json and jaro-winkler.json are unchanged.

## 6. test/lexicon re-vendor

1. While B is unmerged: copy `garganorn/lexicon/*.json` from B's branch head into `test/lexicon/`, byte for byte, and set `SOURCE` to `garganorn <B branch sha> garganorn/lexicon/`. CI's `fixtures` job may fail on a branch-only SHA, which is acceptable on a draft PR. Never hand-edit lexicons to the expected shape.
2. Once B merges to garganorn main: re-copy from the main commit where B's lexicon changes land. Put its full SHA in `SOURCE`. Add or remove files to match exactly, since the check fails on extra or missing files. Run `bash scripts/check-fixtures.sh --lexicon test/lexicon` and confirm no failure and no "behind" warning. This must happen before C's PR merges.
3. Port-side lexicon copies follow from the ports' own re-vendor (they take `test/lexicon/` at C's merge commit).

## 7. Pinned reference commit (R8)

Line 5 cites `8654ea7`. Squash merges (#39 to #42) mean no commit made on the PR branch survives on main, so the PR can't cite its own reference commit. Settled: **Option C**.
- **Inside this PR (pre-merge text):** line 5 reads "The reference is the TypeScript source in `src/` at the commit this document was written against, the squash merge of schuyler/atgeo-sdk-js#43 (its SHA is recorded here by the follow-up commit; until then, take the merge commit of the PR that closed #43)." The PR doesn't carry a SHA that would not survive the merge.
- **After the follow-up commit:** right after the squash merge, a docs-only commit on main replaces the parenthetical with the merge SHA. It then reads "…at the commit this document was written against (`<40-hex merge sha>`)." It touches nothing but that line, so `src/` and `fixtures/` are identical at the merge commit and the follow-up. The follow-up is its own small PR, and the port tickets pin the follow-up commit (main-agent decision 1).

## 8. Failing tests to write first (red)

Each one fails today for the reason given. Fixture-driven ones are red once the fixture edits land.

| Test (file) | Asserts | Why red today |
|---|---|---|
| wire.test.ts (fixture) tilePayload cases | the reader returns `{records, attribution?}` | returns a bare array |
| wire.test.ts getPlace cases | reads `value` and `attribution`; `record`-only is DecodingError | reads `record` |
| wire.test.ts describeService/describeTileset new cases | `maxTiles` and `overview` kept | fields dropped |
| attribution.test.ts (new; fixture runner over a raw fetch) | §5 scenarios | `result.attribution` and `hit.collection` undefined |
| ranking.test.ts | passes `s.dataset`/`s.collection` from the fixture | (green once the fixture has the fields; guards the runner) |
| client.test.ts "rejects a search with no dataset, synchronously, before any request, with a dataset message" | `expect(() => client.searchPlaces({ region } as never)).toThrow(/dataset/)`, zero requests | defaults to overture |
| client.test.ts "rejects a collection named without a dataset" | same, with `{ collection: "division", region }` | defaults to overture |
| client.test.ts "dataset is required in the type" | `expect(() => { // @ts-expect-error dataset is required` (directive on its own line) `client.searchPlaces({ region }); }).toThrow(TypeError)`. The untyped call sits inside the arrow, so the runtime throw is caught and the run doesn't crash. `npm run typecheck` checks the directive | today the directive is unused, so typecheck fails, and the call doesn't throw, so vitest fails |
| client.test.ts "attribution includes reference entries, sorted" | OSM fake with `references`; `result.attribution` equals the sorted union | undefined |
| client.test.ts "hits carry their collection by prefix; a uri-keyed hit has null" | way/wayside/uri | undefined |
| client.test.ts "getPlace returns attribution on the network path and the cache path, in served order" | The fake tileset has collection `overturemaps.org/place` and references `[{dataset:"z.example",collection:"c"}, {dataset:"a.example",collection:"c",release:"1"}, {dataset:"a.example",collection:"c",release:"2"}]`, so served order differs from sorted order and includes a duplicate pair. Both paths return exactly `[place, z.example/c, a.example/c r1, a.example/c r2]` (`toStrictEqual`). The fake's tile and getPlace lists are identical, so the existing `toEqual(network)` then also covers it | undefined; the old `toEqual(network)` passes vacuously |
| client.test.ts describeService/describeTileset | `maxTiles: 50`, `overview: { records }` | dropped (needs §3 fake and §6 lexicons) |
| cache.test.ts "a warm offline search has the same, non-empty attribution and hit collections" | `first.attribution.length > 0`, `second.attribution` equals it, and `second.places.map(p => p.collection)` equals the first search's (non-null for the place hits) | undefined |
| cache.test.ts "getPlace from the cache gives an empty attribution when the tile has none" | raw fetch (robustness-style), a tile `{ records: [good] }` with no `attribution` (and a second case with `attribution: {}`); search; go offline; `getPlace` returns `toStrictEqual({ origin, place, importance, attribution: [] })` | undefined |
| robustness.test.ts "a search whose tiles lack attribution has an empty attribution and null hit collections" | raw tile `{ records: [good] }`; `result.attribution` `toStrictEqual([])`; every hit has the key `collection` with value `null` (`toHaveProperty("collection", null)`) | undefined |
| robustness.test.ts "an unusable tile attribution doesn't fail the tile" | `{records:[good], attribution:"x"}` gives complete true, attribution `[]` | `[]` vs undefined |
| robustness.test.ts getPlace body | the new-shape body succeeds; `{record}`-only rejects with DecodingError | inverse today |
| frozenPlace.test.ts "changing a result's attribution leaves the next search's alone" | tileset collections configured with `licenses` (and `release`); mutate `r1.attribution[0].licenses` (push) and `.release`; a re-search's `attribution` equals the original | undefined, so it throws on `[0]` |
| client.test.ts "a missing dataset is reported before an invalid region" | `expect(() => client.searchPlaces({ region: { bbox: [0, 10, 1, 5] } } as never)).toThrow(/dataset/)` | today the call throws "invalid bbox" |
| client.test.ts "a dataset that is not a string is missing" (it.each `null`, `5`, `["overturemaps.org"]`) | throws `TypeError` /dataset/ synchronously, zero requests | today `null` falls back to the default; the others reach the server |
| client.test.ts "an empty dataset goes to the server" | `searchPlaces({ dataset: "", region })` rejects with `AtgeoError` `DatasetNotFound`, and the one getTiles request has `dataset=""` | (green today; guards the DECISION against a later over-strict check) |
| cache.test.ts "a search's attribution comes only from its own tiles" | two tilesets with distinct entries in separate tiles (a and b, `tilesFor` by bbox); search region A, then B; B's `attribution` lacks A's entry although tile a is still cached | undefined |
| cache.test.ts "getPlace from the cache takes the lowest-URL tile's attribution" | two tilesets holding the same origin in `a.json` and `b.json` with distinct `references`; after caching b, then a, getPlace (offline) returns a's attribution exactly (`toStrictEqual`). a's references are served in non-sorted order with a duplicate pair (`z.example/c`, `a.example/c` r1, `a.example/c` r2), so the order and the duplicates are pinned on the cache path | undefined |
| client.test.ts "changing a getPlace answer's attribution changes nothing cached" | fake collection with `licenses: ["https://l.example/1"]`; search, then `getPlace` from the cache; push onto `p.attribution[0].licenses` and set `p.attribution[0].release = "x"`; a re-search's `result.attribution` and a second `getPlace`'s `attribution` still equal the originals | undefined, so it throws on `[0]` |
| fakeServer.test.ts | getPlace body keys `attribution, importance?, uri, url, value`; describeService has `maxTiles` | old fake shape |

The other existing tests are mechanically updated:
- Every `searchPlaces` call in test/ and scripts/ (about 107 by grep, counting multi-line calls; recount) that lacks one gains `dataset` (plus `collection: "place"` where it relied on the default), through a shared `const OVERTURE = { dataset: "overturemaps.org", collection: "place" } as const` in fakeServer.ts. The two default tests are deleted.
- The region.test.ts "bad region" and "similarity" tests must pass a dataset and assert their own message. If they don't, they pass vacuously on the dataset error (bug risk, §11).
- Robustness tests that pass `dataset: "overturemaps.org"` keep it, and their comment about "the default collection filter" is reworded.
- The robustness getPlace bodies switch to `value`.
- limits.test.ts:607's getPlace body becomes `{ value: … }`.
- robustness.test.ts:196's exact getPlace `toEqual` (the `uri: 5` body) switches its body to `value` and its expectation gains `attribution: []`.
- client.test.ts:49 (`toEqual({ origin, place: value, importance: 80 })`) and :84 (the uri-keyed cache answer) are exact getPlace assertions; both gain `attribution` (the fake tileset's list, as served). cache.test.ts:118 likewise.
- cache.test.ts:94 (`await expect(client.searchPlaces({ region })).rejects.toThrow()`, offline after expiry) must gain the dataset. Without it the call throws the dataset `TypeError` synchronously, outside `expect`, instead of rejecting. The test would then error rather than check offline expiry. Sweep every `expect(client.searchPlaces(...)).rejects`/`.resolves` site the same way (region.test "accepts minLon > maxLon", overview, transport, limits).

## 9. Docs and README

README.md:
- Synopsis: pass `dataset: "overturemaps.org", collection: "place"` and print `hit.collection`. Mention showing `result.attribution`.
- Options table: `dataset` Required, no default. The dataset/collection bullets lose "neither" and "only collection" and gain "Leaving out `dataset` throws a `TypeError` before any request."
- Line 89: drop "including the default …".
- Regions: `{ bbox: [west, south, east, north] }`; "west > east crosses the antimeridian".
- Errors (line 180): `south > north`, and a missing dataset.
- The `SearchResult`/`SearchHit` blocks gain `attribution` and `collection`. A new "#### Attribution" subsection covers what it is, references, sort order, the lowest-URL rule, that it's a copy, and `hit.collection` semantics including null.
- `importance` comment: "comparable across one producer's tilesets of a dataset".
- getPlace returns `{ origin, place, importance, attribution }`.
- describeService adds `maxTiles?` (informational); describeTileset adds `overview?: { records? }`.
- DecodingError line: "no `value` object".
- Privacy line 194: drop "(including the default `place`)".
- Fixtures list: `attribution-scenarios.json`, and the tilePayload result shape.
- Server requirements: "a garganorn from the release tracked in schuyler/garganorn#27 (getPlace with `value` and `attribution`) that serves the dataset you name; the SDK assumes no particular dataset."

Port specs (docs/{swift,kotlin,python,rust}-sdk-spec.md):
- Required (R5): rename the Bbox region fields and constructor parameters to `west, south, east, north` in the same positions. That is Swift line 86–87, Kotlin 89–90 and 290 (the fixture region text), Python 135–138, 182 (the Box/Bbox axis sentence: names now shared, order differs) and 225, and Rust 120–125.
- DECISION, falls out of R1: make `dataset` non-optional in each spec's `searchPlaces` signature (Swift 48/69, Kotlin 72, Python 98/115, Rust 133). Python 124 lists `dataset` among "the optional arguments … absent only when they are `None`"; reword it so `dataset` is a required keyword-only argument (a call without it raises `TypeError`). The `dataset=""` remark stays, since an empty dataset is still sent as given. A sweep of the Swift, Kotlin and Rust specs found no equivalent prose, only the signatures. Kotlin 126/133/139 are the lenient describe types and stay nullable. Also change "no `record` object" mentions (Python 184 and 227, and any others) to `value`. Attribution API shapes are left to each port's ticket and the contract. Reviewer: confirm this scope or trim it to R5 only.

scripts/e2e.ts and e2e.browser.ts change only where the requirements force them. They already pass `dataset` explicitly (default `openstreetmap.org`), and they read only `place`, `origin`, `distance` and `score`, which are unchanged. So they need no edit beyond what typecheck (`tsconfig.scripts.json`) demands after the type changes, and no new assertions. They only work against a #27 server.

## 10. Implementation steps (partition)

Each step is red, then green, then `npm test && npm run typecheck`.
1. **R1 required dataset.** Types, runtime check, deleting the defaults, the `OVERTURE` helper, sweeping every call site, the region.test message assertions, contract §3/§4.1, README options. Also add the `dataset`/`collection` fields to ranking-scenarios.json and make ranking.test pass them, since the sweep reaches ranking.test here. Independent of B.
2. **Fixtures plus readers, except getPlace.** Edit the tilePayload, describeService and describeTileset groups of lenient-readers.json. Add `readAttributionList`, the `readTilePayload` shape, `maxTiles` and `overview`; wire.test is green for those groups. Because `readTilePayload` now returns `{ records, attribution? }`, `client.fetchTile` unwraps `.records` here (`const { records } = readTilePayload(...)`) so typecheck and the suite stay green. Step 3 then carries `attribution` through. Independent of B's lexicons, since wire.test has no fake.
3. **Attribution pipeline (search side).** `attribution.ts`, cache entry and `find`, generic dedupe, rank, client search. Add attribution-scenarios.json and attribution.test.ts on a raw fetch, with a fresh client per scenario. Search-side client, cache, robustness and frozenPlace tests (the fake's tiles already carry attribution). Contract §4.4, §4.10, §8, §10. Independent of B.
4. **getPlace and describe, through the fake.** Blocked on tranche B's branch lexicons. Do §6 step 1, then:
   - Edit the getPlace group of lenient-readers.json and change `readPlace` to `value`/`attribution`. Change client `getPlace` (the cache path returns the tile's attribution, the network path the response's).
   - Make the §3 fake changes: the getPlace shape and the constant `maxTiles: 50`, `overview`.
   - Switch the robustness getPlace bodies to `value`.
   - Tests:
     - the client.test getPlace attribution test (C39, network and cache paths, served order);
     - C40 cache.test "getPlace from the cache takes the lowest-URL tile's attribution";
     - cache.test "getPlace from the cache gives an empty attribution when the tile has none" (C40b);
     - C41 client.test "changing a getPlace answer's attribution changes nothing cached";
     - the exact-assertion updates at client.test.ts:49 and :84 and cache.test.ts:118;
     - limits.test.ts:607 `{ record: … }` → `{ value: … }`;
     - the robustness getPlace bodies (including :196's exact `toEqual` gaining `attribution: []`), the describe tests, fakeServer.test.

   These go together. The reader change alone would turn every fake-backed getPlace test (client, cache, frozenPlace, robustness) red against the fake's old `record` shape, and the fake change alone would fail the fake's own validation against the old lexicons. Contract §1 getPlace line, §9.
5. **Docs.** Contract §1, §3 names, the §4.1/§8 #14 notes, §9 describe text, §13 counts; README; port specs; pin line (§7).
6. **Final re-vendor** at the garganorn main commit (§6 step 2), then check-fixtures, then open the PR.

## 11. Risks and likely bugs

- **Vacuous green.** Region and similarity validation tests without a dataset now throw the dataset `TypeError` and still pass. Pass a dataset and assert the message.
- **Vacuous equality.** `toEqual(first)` and `toEqual(network)` pass when both sides lack `attribution`. Assert non-empty explicitly.
- **Wrong attribution for a hit's collection.** Matching against the merged result list, or against whichever cached tile `find` returns, instead of the kept copy's own tile, gives a wrong collection when copies' tiles differ (scenario 7).
- **Matching on the wrong key.** Using `hit.origin` (with the `uri` fallback) instead of `value.origin` lets a crafted `uri` starting with `urn:atgeo:` get a collection.
- **Union key collisions.** `` `${dataset}|${collection}` `` merges `a|b`+`c` with `a`+`b|c`. Use a tuple key.
- **Locale sorting.** `localeCompare` or `Intl.Collator` sorts `Example.org` after `example.org`. Ports must reuse their 4.3 UTF-16 comparator; Python, Rust and Swift default comparisons are code-point or byte order, which differs above U+FFFF. No fixture pins that margin. Mention it in the contract (GUESS: not worth a fixture).
- **Wrong tile set.** Including attribution from failed tiles, or from cached tiles not in this search's URL list. Build only from `loaded`.
- **Aliasing.** Result entries aliasing cache objects (including the `licenses` array) let an app corrupt later searches. Copy.
- **Absent vs empty.** The tile reader leaves attribution absent, while the getPlace reader returns `[]`. Ports may conflate them, and the fixture pins both.
- **Fixture keys.** `present()` must run on attribution entries and on `overview`, or strict fixture equality fails on `undefined`-valued keys.
- **Guard placement.** Attribution decoding must stay inside the guarded decode step. Only the cache store and merge are unguarded (§4.4 rule).
- **Lexicon drift.** If B makes `maxTiles` required or names `getPlace.attribution` differently, the fake's validation will catch it at §10 step 4 (GUESS: names are final per #15/#19).
- **Pin hygiene.** CI `fixtures` stays red while `test/lexicon/SOURCE` names a branch-only SHA. Don't merge before §6 step 2.
- **Port churn.** The tilePayload fixture's result-shape change breaks every port's wire runner until it changes its mapping. That is intended, and the port tickets should say so.
- **Performance.** Pairing records with attribution allocates one object per record per search (roughly 40k on a warm 8-tile search). That's acceptable; if profiling disagrees, fold dedupe and filters into one loop over tiles.

## 12. Behaviour coverage

Every behaviour this design specifies or changes. For each one: (a) the contract section and the drafted sentence that requires it (quoted from §1 above), and (b) the red test or fixture case that fails without it. "LR" means `fixtures/lenient-readers.json`, "AS n" means `fixtures/attribution-scenarios.json` scenario n, and "RS" means `fixtures/ranking-scenarios.json`. A row marked doc-only changes no observable behaviour.

| # | Behaviour | (a) Contract § and sentence | (b) Red test / fixture |
|---|---|---|---|
| C1 | A search without a dataset is an argument error, raised before any request | §4.1 "`dataset` is required and has no default. A search without one is an argument error, raised before any request" | client.test "rejects a search with no dataset … zero requests"; the type-level `@ts-expect-error` test |
| C2 | The dataset check comes before the region and sort checks | §3 Validation, new first bullet "a search with no `dataset` (section 4.1);" | client.test "a missing dataset is reported before an invalid region" |
| C3 | A non-string dataset counts as missing (dynamic ports) | §4.1 "A dynamically typed port treats a `dataset` that is not a string as missing." | client.test it.each `null`/`5`/array |
| C4 | An empty-string dataset is sent to the server (DECISION) | §4.1 "An empty string is a string and goes to the server." | client.test "an empty dataset goes to the server" |
| C5 | A collection without a dataset is the same argument error | §4.1 "A `collection` given without a `dataset` is the same argument error." | client.test "rejects a collection named without a dataset" |
| C6 | A dataset alone covers the whole dataset, with no collection parameter | §4.1 "Without one it covers the whole dataset, with no collection filter." (plus the unchanged parameter sentence) | existing client.test "searches a whole dataset when only the dataset is named" (kept; sweep adds nothing) |
| C7 | The no-defaults rows are removed | §4.1 table deleted | the deleted default tests are replaced by C1/C5 |
| C8 | Ranking a dataset-only search across tilesets is unchanged | §4.1 "…That is sound: the atgeo spec defines importance as comparable across the tilesets one producer builds from one dataset…"; §8 "Importance is comparable across one producer's tilesets for one dataset…" | doc-only (no behaviour change); existing merge/ranking tests stay green |
| C9 | Ranking fixtures name their dataset and collection | §8 "…as a search of the scenario's `dataset` and `collection`…" | RS gains the fields; ranking.test passes them (step 1) |
| C10 | Bbox regions are named `west, south, east, north`, with the wire order unchanged | §3 "…a bounding box `[west, south, east, north]` in degrees… the same four values in the same order, which is also the order of the `getTiles` bbox string." | doc-only for names; order is pinned by the existing region.test §3 table cases, kept unchanged |
| C11 | Tile `attribution` is optional: absent unless an array | §1 "In a tile payload it is optional: absent unless it is an array." | LR tilePayload "attribution that is not an array is absent" (`{}`, `null`) |
| C12 | An attribution entry is kept only with string `dataset` and `collection`; its fields are read on their own; extras are ignored | §1 "An element is kept only if it is an object whose `dataset` and `collection` are both strings. … Each field is read on its own, and other fields are ignored." | LR tilePayload "attribution entries are read leniently"; LR getPlace "attribution is read leniently"; AS 8 |
| C13 | The reader keeps served order and duplicates | §1 "Entries keep their served order, duplicates included." | LR tilePayload lenient case (two `d/c` entries kept); LR getPlace "attribution keeps served order and duplicates" |
| C14 | A malformed attribution never fails a tile | §4.4 "A malformed `attribution` never fails a tile, since it only drops entries." | robustness.test "an unusable tile attribution doesn't fail the tile" |
| C15 | The tile reader's result shape is `{records, attribution?}` | §1 tile payload line "Of the payload, `attribution` is kept (below)…"; §13 fixture description | LR tilePayload (all 15 rewrapped cases) |
| C16 | `SearchResult.attribution` exists | §4.9 result shape "`{ places, complete, overview, tiles, tileFailures, attribution }`" | AS 1 to 12; client.test "attribution includes reference entries, sorted" |
| C17 | Reference entries are included | §4.10 "Reference entries are included…" | AS 1; client.test (OSM fake with `references`) |
| C18 | Every used tile contributes, including one with no surviving records | §4.10 "…from every tile the search used (4.4), from the cache or the network, whether or not any of the tile's records survived 4.6 to 4.9." | AS 4 |
| C19 | A failed tile (status or decode) contributes nothing, even when its body has readable attribution | §4.10 "A failed tile contributes nothing." | AS 5 (decode-failed tile with a `leak.example` entry, and a 500 tile) |
| C20 | A cached tile outside this search's URL list contributes nothing | §4.10 "…every tile the search used…" | cache.test "a search's attribution comes only from its own tiles" |
| C21 | Duplicates across tiles: the first in URL order wins | §4.10 "Walk the used tiles in URL order (4.3), and each tile's entries in served order, and keep the first entry for each `(dataset, collection)` pair" | AS 2 (listed b then a; a's release wins) |
| C22 | Duplicates within a tile: the first wins | the same §4.10 sentence | AS 9 |
| C23 | The pair is compared as exact strings (no case folding) | §4.10 "…compared as exact strings." | AS 3 (`Example.org` and `example.org` both kept) |
| C24 | Sort by dataset then collection, ordinal | §4.10 "Then sort by `dataset`, then `collection`, each in the ordinal order of 4.3." | AS 3 (uppercase first, `way` < `wayside`); AS 11 (`a` < `a:b`) |
| C25 | No tiles, or no used tile with an attribution, gives an empty attribution, never absent or null | §4.10 "`attribution` is always present on a result, never absent or null. It is an empty list when no tile was used, or when no used tile has an attribution…" | AS 10; AS 8; robustness.test "a search whose tiles lack attribution has an empty attribution and null hit collections" |
| C26 | Result entries carry exactly the fields the reader kept | §4.10 "Each entry is surfaced with the fields section 1 kept." | AS 1 (strict deep equality, with release/licenses/source/attribution) |
| C27 | Result attribution is a copy or immutable | §4.10 "The app may change what it is given without changing the cache…"; §9 new attribution sentence | frozenPlace.test "changing a result's attribution leaves the next search's alone" (licenses configured) |
| C28 | The tile cache keeps attribution, so a warm search has it and the same hit collections, with no request | §10 "Tiles: keyed by URL, each holding its usable records and its `attribution` (section 1), so a warm search (4.10) and the getPlace scan (section 9) have it without a request." | cache.test "a warm offline search has the same, non-empty attribution and hit collections" |
| C29 | A port that reparses bodies reparses attribution too; tile size is unchanged | §10 "A port that holds bodies and parses them again parses the attribution again too." and "a tile's size is still its body length" | no TS behaviour change (the reference caches parsed records); size unchanged, and the contract already says §10 has no budget test; covered for ports by C28 |
| C30 | `SearchHit.collection` comes from the first matching entry of the kept copy's tile | §8 row "…of the first entry, in served order, of the `attribution` of the tile the record came from (the tile whose copy 4.6 kept)…" | AS 7; AS 11 (first in served order) |
| C31 | The match is the 4.7 prefix test with the trailing colon, never splitting the URN | §8 row "…starting with `urn:atgeo:{dataset}:{collection}:`, the test of 4.7 … The origin is never split." | AS 6 (way vs wayside); AS 11 (colon-bearing names); client.test "hits carry their collection by prefix" |
| C32 | No match, no attribution, or a non-string `value.origin` gives null; matching uses `value.origin`, not the `uri` fallback | §8 row "It is null when no entry matches, when the tile has no attribution, or when `value.origin` is not a string (a record keyed by its `uri`)." | AS 6 (`example.org` origin; urn-shaped `uri`); AS 8 |
| C32b | A tile without attribution gives each of its hits `collection: null`, present and never absent | §8 row "A tile without an attribution counts as an empty list here. `collection` is always present on a hit: an object or null, never absent." | AS 8 (the runner requires the `collection` key, with strict equality); robustness.test "…null hit collections" (`toHaveProperty("collection", null)`) |
| C33 | A collection-filtered search whose tile lacks the pair gives null (DECISION) | §8 DECISION text, drafted into the row: "…null when no entry matches…" | AS 12 |
| C34 | `collection` is a fresh object with exactly `{dataset, collection}` | §8 row "a new object holding exactly `{ dataset, collection }` (no other field of the entry, and not the entry itself)" | AS 1 and 6 (strict equality; entries carry extra fields) |
| C35 | getPlace reads `value`; `uri` and `url` are not read | §1 getPlace line "`value` must be an object, or the response has no usable body… `uri` and `url` are not read." | LR getPlace "the full answer" and all rewritten cases; robustness.test getPlace body (new shape succeeds) |
| C36 | A `record`-only body has no usable body | §1 Errors "a `getPlace` body with no `value` object … A body in the earlier shape, with `record` and no `value`, has no usable body." | LR getPlace "no usable body: the earlier shape"; robustness.test `{record}`-only rejects with DecodingError |
| C37 | getPlace attribution is required: `[]` when not an array | §1 "In `getPlace`, which requires it, it is empty unless it is an array." | LR getPlace "attribution that is not an array is empty"; every non-error LR getPlace result gains `"attribution": []` |
| C38 | SDK `origin` is the wire record key and `place` is `value`; the returned origin is the caller's | §9 "The SDK's `origin` is the wire's record key: the `uri` parameter of `getPlace`, which its response echoes as `uri`. The SDK's `place` is the wire's `value`…"; existing "The returned `origin` is the caller's string" | existing client.test "sends one getPlace request with the origin as uri"; robustness.test (`uri: 5` is ignored) |
| C39 | Network getPlace attribution is the response's, as served (order and duplicates) | §9 "…where `attribution` is the response's `attribution` as read (section 1). Neither is merged or sorted: it keeps served order, duplicates included." | client.test "getPlace returns attribution on the network path and the cache path, in served order" (unsorted with a duplicate pair, exact); client.test:49 exact `toEqual` with `attribution`; LR getPlace "attribution keeps served order and duplicates" |
| C40 | Cache getPlace attribution is the lowest-URL source tile's, as served | §9 "…where `attribution` is the source tile's `attribution` as read (section 1), or empty when the tile has none (absent, or not an array). That tile is the lowest-URL one holding the record." | cache.test "getPlace from the cache takes the lowest-URL tile's attribution" (unsorted with a duplicate pair, exact); client.test "…in served order" (cache path); client.test:84 and cache.test:118 exact assertions |
| C40b | Cache getPlace from a tile with no attribution (absent or not an array) gives `[]`, matching the network path's `[]` | §9 "…or empty when the tile has none (absent, or not an array)… On both paths `attribution` is always a list, never absent or null." | cache.test "getPlace from the cache gives an empty attribution when the tile has none" (absent and `{}` cases); LR getPlace "attribution that is not an array is empty" for the network path |
| C41 | getPlace attribution is a copy or immutable (the cache path aliases the tile) | §9 new sentence "…an app that changes an entry or its `licenses` list changes neither the cached tile nor a later search's or `getPlace`'s answer." | client.test "changing a getPlace answer's attribution changes nothing cached" |
| C42 | getPlace sends only `uri` (unchanged) | §12 item 4, unchanged | existing privacy/client tests |
| C43 | describeService passes `maxTiles` through, read as an integer | §1 describeService line "`{ did, maxTiles?, … }`"; §1 "The same reading applies to … `maxTiles` in describeService…"; §9 "That includes `maxTiles`…" | LR describeService "a full answer", fractional, non-number, out-of-range; client.test describeService `maxTiles: 50` |
| C44 | describeTileset passes `overview` through: absent if not an object, `records` an integer or absent, unknown fields ignored | §9 describeTileset "…It is absent when the tileset has no overview band, or when the field is not an object. When present it is an object whose `records` … is read as in section 1 and is absent when unreadable. Unknown fields in it are ignored." | LR describeTileset "a full answer", "…unknown fields are ignored", "…empty overview", "…not an object is absent"; client.test describeTileset `overview` |
| C45 | describeTileset stays uncached; describeService stays cached for an hour | §9 "Never cached." / "Cached for one hour" (unchanged) | existing client.test "describeTileset asks the server each time"; cache.test "caches describeService for 3600 s" |
| C46 | Attribution adds no request | §12 "No change. Attribution adds no request…" | cache.test "a warm offline search has the same, non-empty attribution" (offline, so any request would fail); existing privacy.test "issues only getTiles and tile requests" |
| C47 | The fixture runners reset per scenario | §13 runner text "use a fresh client per scenario" | attribution.test constructs one client per scenario. The guard is that AS 2 and AS 7 both use the tile URLs `a.json` and `b.json` with different bodies. With a shared client, AS 7 (run after AS 2 in file order) would read AS 2's cached tiles by URL and fail its expected collection and attribution |
| C48 | The pinned reference line | §7 pre-merge and post-follow-up text | doc-only (process); verified by reviewing the follow-up PR |
| C49 | Port specs and README renames, and the required dataset in port signatures | §9 of this design (docs list) | doc-only |

Gaps found while building this table, and filled above: C2, C3 and C4 (new client.test rows); C13 for getPlace (new LR case); C20, C40 and C40b (new cache.test rows); C25 and C32b (explicit empty and null, new robustness row); C30 and C31 (scenario 11), C32 (the scenario 6 edit to a urn-shaped `uri`), C33 (scenario 12); C34 (strict equality and extra fields); C41 (new §9 sentence and test).

## 13. Red-gate mutation check

The red-phase reviewer copies the repo to a scratch directory and injects each mutant below into `src/`, one at a time, then runs `npx vitest run` (and `npm run typecheck` where noted). Each mutant must turn at least the named test or fixture case red. A mutant that stays green is a coverage gap: add a case before going green. The mutants are plausible port bugs.

| # | Mutant | Must go red |
|---|---|---|
| M1 | Hit collection matched against the merged and sorted result list, not the kept copy's own tile in served order | AS 11 (sorted order picks `{a, b:c}`); AS 7 (the merged list holds b's entry, so non-null) |
| M2 | Tile attribution read before `records` is validated, so a decode-failed tile's attribution leaks | AS 5 (`leak.example` appears) |
| M3 | Last-wins dedupe of attribution pairs (across tiles or within one) | AS 2 (b's release); AS 9 (`release: "2"`) |
| M4a | Pair key joined with `:` | AS 11 (`a`+`b:c` and `a:b`+`c` merge into one entry) |
| M4b | Pair key joined with `\|` | AS 3 (`a\|b`+`c` and `a`+`b\|c` merge) |
| M5 | `mergeAttribution` (dedupe and sort) applied on the getPlace path | client.test "getPlace returns attribution … in served order" (both paths); cache.test C40 (unsorted with a duplicate pair) |
| M6a | getPlace cache path returns absent or undefined attribution for a tile without one | cache.test "getPlace from the cache gives an empty attribution when the tile has none" (C40b) |
| M6b | `SearchResult.attribution` absent or undefined when no used tile has one | robustness.test "a search whose tiles lack attribution…" (C25); AS 8 and AS 10 (deep-equal to `[]`) |
| M7a | getPlace attribution returned without copying (aliases the cached tile) | client.test "changing a getPlace answer's attribution changes nothing cached" (C41) |
| M7b | Search attribution returned without copying (entries or `licenses` alias the cache) | frozenPlace.test "changing a result's attribution leaves the next search's alone" (C27) |
| M8 | Dataset check moved after `validateRegion` or the sort check | client.test "a missing dataset is reported before an invalid region" (C2) |
| M9 | `describeTileset` cached (like describeService) | client.test "describeTileset asks the server each time" (C45) |
| M10 | Hit collection matched on the key (`value.origin`, else `uri`) | AS 6 (urn-shaped `uri` gets a collection) |
| M11 | Prefix built without the trailing colon | AS 6 (`…:wayside:9` matches `way`) |
| M12 | Attribution built from every cached tile, not this search's used tiles | cache.test "a search's attribution comes only from its own tiles" (C20) |
| M13 | Attribution only from tiles that produced a hit (references or empty tiles dropped) | AS 1 (division reference); AS 4 (tile with no surviving records) |
| M14 | `localeCompare` or a case-insensitive sort | AS 3 (`Example.org` before `example.org`) |
| M15 | Hit `collection` returned as the matching entry itself (extra fields) | AS 1 and AS 6 (strict equality) |
| M16 | Hit `collection` key omitted when null | AS runner key requirement (AS 6, AS 8); robustness.test `toHaveProperty("collection", null)` (C32b) |
| M17 | Tile reader sorts or dedupes entries, or keeps entries missing `dataset`/`collection` | LR tilePayload "attribution entries are read leniently"; LR getPlace "attribution keeps served order and duplicates" |
| M18 | Tile reader returns `[]` instead of absent for a non-array attribution | LR tilePayload "attribution that is not an array is absent" |
| M19 | getPlace reader falls back to `record` when `value` is missing | LR getPlace "no usable body: the earlier shape"; robustness.test `{record}`-only |
| M20 | getPlace reader leaves attribution absent when not an array | LR getPlace "attribution that is not an array is empty" |
| M21 | Tile cache doesn't keep attribution (warm search loses it) | cache.test C28 (warm offline search, attribution and hit collections) |
| M22 | getPlace cache path takes the attribution of the first-cached or highest-URL tile | cache.test C40 |
| M23 | Runtime dataset check only for `undefined` (lets `null` or `5` through) | client.test "a dataset that is not a string is missing" (C3) |
| M24 | Empty-string dataset rejected | client.test "an empty dataset goes to the server" (C4) |
| M25 | A malformed tile attribution fails the tile | robustness.test "an unusable tile attribution doesn't fail the tile" (C14) |
| M26 | `maxTiles` or `overview` not read, an `overview` with unreadable `records` dropped, or a negative `maxTiles` dropped | LR describeService and describeTileset cases (C43, C44) |
| M27 | The `dataset` property made optional in `SearchOptions` | `npm run typecheck` (the unused `@ts-expect-error`) |
| M28 | Collection filter (4.7) refactored onto the shared `inCollection` with an off-by-one or a uri fallback | existing client.test "matches the collection, not a collection sharing its prefix" and "filters to one collection, dropping records with no origin" |

## Main-agent decisions on the design's open questions (settled)
1. Pinned reference commit: Option C. Line 5 keeps citing a SHA. After this PR squash-merges, a
   docs-only follow-up commit (own small PR) writes the merge commit's SHA into line 5; port
   tickets pin that follow-up commit (fixtures and src/ are identical to the merge commit).
2. Port-spec scope: as proposed — bbox renames, `dataset` non-optional in each port spec's
   searchPlaces signature, `record` → `value` mentions. Attribution API shapes left to port tickets.
3. Lexicon assumptions are re-checked against tranche B's lexicons when they land; the B lexicon
   is authoritative.

## Red-gate decisions (settled, main agent)
- R-1: AS 12 gains a uri-keyed record with a urn-shaped uri and no `value.origin`
  (`uri: "urn:atgeo:openstreetmap.org:way:77"`) under a collection-filtered search; it must NOT be a hit.
  Pins §4.7's origin-only filter (mutant M28 uri-fallback).
- R-2: Sequencing. The green phase is ONE pass covering §10 steps 2–4 together (including the
  lexicon-dependent step 4), run against tranche B's branch lexicons copied into test/lexicon/ once
  B's lexicon commit exists; test/lexicon/ is re-vendored from garganorn main (exact merge commit,
  SOURCE updated) after B merges and before C's PR. No test is moved or weakened; the suite is never
  left red at the end of a step. This supersedes §10's per-step "npm test green" for steps 3/4.
- R-3: The attribution-scenarios runner rules (fresh client per scenario, default body for a
  status-only tile, base server https://places.atgeo.org, raw-server routing) must land in the
  contract's §13 text in the docs phase; the docs gate checks it. The UTF-16 vs code-point ordering
  note goes in the contract as stated-unpinned.
- R-4: The contract's conformance text must tell ports that fixtures cannot express tile arrival
  order, and that each port needs its own test that the attribution union and dedupe follow tile URL
  order whatever order tiles arrive in (TS: attribution.test "tiles arriving in reverse URL order").
- R-5: Red-gate mutation bar is CLOSED: every known mutant (M1–M28, Y1–Y2, N1–N28 as numbered in the
  review reports) must go red; reviewers verify, they are not required to invent new ones.
