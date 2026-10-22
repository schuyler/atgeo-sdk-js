# @atgeo/client

A TypeScript/ESM client for the atgeo gazetteer served by [garganorn](https://github.com/schuyler/garganorn), which searches places without telling the server what you searched for.

It runs in evergreen browsers, Node 20 or later, and workers, and has no runtime dependencies.

## Synopsis

```ts
import { AtgeoClient } from "@atgeo/client";

const atgeo = new AtgeoClient();

const { places, complete } = await atgeo.searchPlaces({
  region: { lat: 39.9526, lon: -75.1652, radius: 1000 }, // meters
  text: "Starbux",
});

for (const { origin, place, distance, score } of places) {
  console.log(place.name, Math.round(distance), score?.toFixed(2), origin);
}
```

Misspellings are fine; matching is fuzzy, and that finds the Starbucks around Philadelphia's City Hall. The public server at places.atgeo.org has a limited dataset for now, mostly the east coast, so a search elsewhere may come back empty. If `complete` is `false`, some tiles failed to load and the results are partial. If `overview` is `true`, the region was too big to search in full and you got only its most important places; see [Overview answers](#overview-answers).

## Installation

This isn't on npm yet; it stays unpublished until beta testing ends. Install it from GitHub instead, pinned to a commit:

```sh
npm install github:schuyler/atgeo-sdk-js#<commit-sha>
```

npm runs the `prepare` script on a git install, which builds `dist/` for you. Pin a full commit SHA rather than a branch: the API is still changing, and breaking changes land on `main`.

To work on it from a checkout, `npm install` builds it too (same `prepare` script), and `npm link` puts it in your project.

## Constructing a client

```ts
const atgeo = new AtgeoClient({
  server: "http://localhost:8000",      // default: https://places.atgeo.org
  fetch: myFetch,                       // default: the global fetch
  cacheBudgetBytes: 10 * 1024 * 1024,   // default: 50 MiB
});
```

Point `server` at your own garganorn to run against your own data; see [Server requirements](#server-requirements). `fetch` is for tests, proxies, or runtimes where you want to supply your own. The budget caps the in-memory tile cache (see [Caching](#caching)).

## API

Every method that touches the network takes an optional `signal` (`AbortSignal`).

### `searchPlaces(options): Promise<SearchResult>`

| Option | Meaning |
|---|---|
| `region` | Required. A circle or bounding box (below). |
| `text` | Optional search text. Matched fuzzily against each place's `name` and its `variants[].name`, after lowercasing and stripping accents and extra whitespace. Each name is scored against the whole query and against the query's first 12 words one at a time; words past the 12th count only in the whole-query comparison. |
| `dataset` | Optional. The dataset to search, such as `openstreetmap.org`. Defaults to `overturemaps.org`. |
| `collection` | Optional. Restricts the search to one collection of the dataset, such as `way`. See below for the defaults. |
| `sort` | `"fused"` (default), `"distance"`, or `"similarity"`. |
| `signal` | Aborts the search. |

Regions:

```ts
{ lat: 39.9526, lon: -75.1652, radius: 1000 }    // circle; radius in meters
{ bbox: [minLon, minLat, maxLon, maxLat] }        // degrees
```

Datasets and collections work like this:

- With neither option, you search `overturemaps.org` / `place`.
- With only `collection`, you search that collection of `overturemaps.org`.
- With only `dataset`, you search the whole dataset, every collection together. `{ dataset: "openstreetmap.org" }` returns nodes, ways and relations in one list, and `{ dataset: "overturemaps.org" }` returns places and divisions together. Add `collection: "way"` to get only ways.
- With both, you search that collection.

A collection-filtered search, including the default `overturemaps.org` / `place`, keeps only records whose `origin` starts with `urn:atgeo:{dataset}:{collection}:`. A record with no `origin` matches no collection filter, so such a search never returns one. A dataset-only search has no filter and returns those records too.

A bbox with `minLon > maxLon` crosses the antimeridian. A place with a point location is kept if the point falls inside the region; a place with only a bounding box is kept if that box touches the region.

The result:

```ts
interface SearchResult {
  places: SearchHit[];
  complete: boolean;                          // false if any tile failed to load
  overview: boolean;                          // true if the server answered with its coarse overview; see below
  tiles: { fetched: number; failed: number };
}

interface SearchHit {
  origin: string | null;               // the place's identity: place.origin, else the tile record's uri, else null
  place: { [key: string]: unknown };   // the record value, exactly as served
  importance: number | null;           // the record's importance, an integer relative to its tileset; null if it has none
  distance: number;                    // meters from the region's center (the circle's center, or the bbox's center) to the nearest point of the place; 0 if the place contains the center
  score: number | null;                // 0 to 1 text similarity; null if no text was given
}
```

When `text` is given, places scoring below 0.6 are dropped.

Sort modes:

- `fused` orders by text similarity (best first), breaking near-ties by the hit's `importance`, then by distance. Without text, that means importance, then distance. This is the one you usually want.
- `distance` orders nearest first, then smaller place first (so the most specific of the places containing the center leads), then by importance, then similarity. Text still filters out poor matches.
- `similarity` orders by text similarity, then nearest first. It throws without `text`.

Similarity is compared to three decimal places, so scores that differ only beyond that count as ties. Remaining ties break on `origin` (a hit with no `origin` sorts last), so ordering is deterministic.

`place` is the gazetteer's value untouched. Importance lives on `hit.importance` and identity on `hit.origin`.

#### Overview answers

When a region is too large for the server's regular tile budget and the collection has an overview, the server answers with that instead: a coarse tileset holding only the most important places. The search still runs normally over those tiles, and `overview` is `true`. The list is not everything in the region.

`overview` and `complete` are independent. `complete` says whether every tile the server named loaded; `overview` says whether the server named a thin set of tiles to begin with. An overview search whose tiles all loaded is `overview: true, complete: true`. If either half of an antimeridian-crossing search gets an overview answer, `overview` is `true`.

If `overview` is `true`, don't treat the results as exhaustive. Show something like "zoom in for more" and search a smaller region to get the full set. Collections without an overview always give `overview: false`. The SDK reads the flag from the `getTiles` response only; it doesn't guess from tile URLs.

#### Places that appear in more than one tile

A place can be stored in several tiles. The SDK keeps one hit per origin (or per `uri`, for a record with no origin). Records with neither can't be told apart, so they're never merged.

When the copies differ, which one you get is decided by tile URL: the copy from the lowest tile URL wins. Garganorn's copies of a multi-tile place are byte-identical, so this only matters for other producers' tilesets, such as an app's edited copies.

The guarantee is that the result is deterministic for the server's answers and the cache's contents, and no stronger. Which copies are present depends on which tiles a search covered, so two searches over different regions can return different copies of the same place. The rule merges copies; it doesn't decide which is correct.

### `getPlace({ origin }): Promise<PlaceRecord>`

Returns `{ origin, place, importance }`, where `place` is the value as served and `importance` is a number or `null`. Pass the `origin` of a hit. If a cached tile holds the place, no request is made; otherwise the client asks the server (`org.atgeo.getPlace`) directly, with no discovery call first. A place with no origin is identified by its tile record's `uri`, which the cache can resolve; the server answers `PlaceNotFound` for a URI it doesn't serve, and `InvalidRequest` for a string that isn't a URI.

A cache hit returns the copy from the cached tile with the lowest URL, the same rule search uses; a network answer is the server's own copy. They agree when the copies are identical, which for garganorn they are.

### `describeService(): Promise<ServiceDescription>`

Returns `{ did, tilesets: [{ slug, collections: [{ dataset, collection }] }] }`. Cached for an hour.

### `describeTileset(slug): Promise<Tileset>`

Returns the tileset's descriptor: `slug`, `collections` (each a `{ dataset, collection }` with optional `release`, `source`, `licenses`, `attribution`, `recordCount`, `locationFormats`, `containmentTypes`, `categories` and `attributes`), and optional `publishedAt`, `extent` and `references`. Not cached.

### Errors

- `AtgeoError` has a `code` string. A non-2xx response from the server becomes an `AtgeoError` whose `code` and message come from the server's JSON error body (`error`, `message`); if there isn't one, the code is `HttpError`. Apart from `HttpError`, every code comes from the server: for example `PlaceNotFound`, `TilesetNotFound`, `DatasetNotFound`, `CollectionNotFound`, `BboxTooLarge`, or `InvalidRequest` for a malformed parameter. The lexicons in `test/lexicon/` list the codes each method declares.
- `searchPlaces` throws `TypeError` for an invalid region (non-finite or out-of-range coordinates, `minLat > maxLat`, negative radius) and for `sort: "similarity"` without text. It throws synchronously, before any request.
- A failed `getTiles` request rejects the whole search. A failed tile request does not: that tile is skipped, `tiles.failed` counts it, and `complete` is `false`.
- Aborting rejects with whatever `fetch` throws, so it only takes effect through a request. A call answered entirely from cache completes normally, even with an already-aborted signal. Network errors from `fetch` propagate as-is.

## Privacy

Your search text never leaves the device. Neither does your precise location.

To search, the client asks the server which tiles cover an area, downloads those tiles, and does the matching, filtering, and ranking locally. The only location a search sends is a bounding box (two across the antimeridian), snapped outward to a 0.01 degree grid (roughly 1 km of latitude) before it goes out; alongside it go the search's dataset and, if it has one, its collection (including the default `place`). Your exact region is used only on the device, to filter and to compute distances.

What does go on the wire:

- `getTiles` with the snapped bbox, the search's dataset, and its collection if it has one. A region that crosses the antimeridian sends two.
- Requests for the tile URLs the server returned, exactly as served, minus any already in the cache. So the server can tell which of those tiles this client fetched before — that you searched near here recently — but nothing finer than the tiles themselves.
- `describeService` and `describeTileset`, only if you call them.
- `getPlace` on a cache miss sends the origin of the place you asked for.

The server also sees your IP address and whatever headers your `fetch` adds, as with any HTTP request. Snapping hides where in a ~1 km cell you are; it doesn't hide the cell.

## Caching

`getTiles` responses and the service description are cached for an hour. Tiles are cached in memory, least recently used out first, up to `cacheBudgetBytes` (measured as the tile's response length in characters). Searching a region again while its tile list and tiles are warm makes no requests at all. `getPlace` checks cached tiles before asking the server.

There is no persistence; a new client starts cold.

## Development

```sh
npm test
npm run typecheck
npm run build
```

There are more scripts in `package.json`, including a browser smoke test and an end-to-end script.

`fixtures/` holds language-neutral contract files, meant for future ports of this client to other languages:

- `normalize.json` and `jaro-winkler.json` are input/output pairs that a port must match exactly.
- `ranking-scenarios.json` describes regions, text, and records, and asserts which places land in the top K. It checks membership, not exact order, since the weights are likely to change. Each record is `{ value, importance }`: `value` is an `org.atgeo.place` with an `origin`, and `importance` is an integer, as on the wire. The expectations name places by `origin`.

`docs/port-contract.md` is the language-neutral statement of what this client does, written for ports; `docs/swift-sdk-spec.md` and `docs/kotlin-sdk-spec.md` are the specifications for the Swift and Kotlin ports.

`test/lexicon/` holds copies of the wire contract's lexicon files, taken from garganorn at the commit named in `test/lexicon/SOURCE`. The test suite's fake server validates every request and response against them, so a test can't pass on a response the real server would never send.

## Server requirements

The SDK needs a garganorn that serves `org.atgeo.getTiles`, `getPlace`, `describeService` and `describeTileset`, and it follows the tile URLs `getTiles` returns as-is. Browsers can call your server directly: garganorn sends `Access-Control-Allow-Origin: *` on every route.
