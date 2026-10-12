# @atgeo/client

A TypeScript/ESM client for the atgeo gazetteer served by [garganorn](https://github.com/schuyler/garganorn), which searches places without telling the server what you searched for.

It runs in evergreen browsers, Node 20 or later, and workers, and has no runtime dependencies.

## Synopsis

```ts
import { AtgeoClient } from "@atgeo/client";

const atgeo = new AtgeoClient();

const { places, complete } = await atgeo.searchPlaces({
  region: { lat: 37.7598, lon: -122.4194, radius: 1000 }, // meters
  text: "Starbux",
});

for (const { uri, place, distance, score } of places) {
  console.log(place.name, Math.round(distance ?? NaN), score?.toFixed(2), uri);
}
```

Misspellings are fine; matching is fuzzy. If `complete` is `false`, some tiles failed to load and the results are partial.

## Installation

This isn't on npm yet. The package is private until beta testing ends, so use it from a checkout:

```sh
npm install
npm run build
```

That puts ESM and type declarations in `dist/`. Import from there, or `npm link` it into your project.

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
| `text` | Optional search text. Matched fuzzily against each place's `name` and its `variants[].name`, after lowercasing and stripping accents and extra whitespace. Only the first 12 words count. |
| `collection` | Defaults to `org.atgeo.places.overture.place`. |
| `sort` | `"fused"` (default), `"distance"`, or `"similarity"`. |
| `signal` | Aborts the search. |

Regions:

```ts
{ lat: 37.7598, lon: -122.4194, radius: 1000 }   // circle; radius in meters
{ bbox: [minLon, minLat, maxLon, maxLat] }        // degrees
```

A bbox with `minLon > maxLon` crosses the antimeridian. A place with a point location is kept if the point falls inside the region; a place with only a bounding box is kept if that box touches the region.

The result:

```ts
interface SearchResult {
  places: SearchHit[];
  complete: boolean;                          // false if any tile failed to load
  tiles: { fetched: number; failed: number };
}

interface SearchHit {
  uri: string;
  place: { [key: string]: unknown };   // the record value, as served
  distance: number | null;             // meters from the circle's center, or the bbox's center; null if the place has no point location
  score: number | null;                // 0 to 1 text similarity; null if no text was given
}
```

When `text` is given, places scoring below 0.6 are dropped.

Sort modes:

- `fused` orders by text similarity (best first), breaking near-ties by the place's `importance`, then by distance. Without text, that means importance, then distance. This is the one you usually want.
- `distance` orders nearest first, then by importance, then similarity. Text still filters out poor matches.
- `similarity` orders by text similarity, then nearest first. It throws without `text`.

Similarity is compared to three decimal places, so scores that differ only beyond that count as ties. Remaining ties break on `uri`, so ordering is deterministic.

### `getPlace({ collection, rkey }): Promise<PlaceRecord>`

Returns `{ uri, place }`. If the place is in a cached tile, no request is made. Otherwise it fetches the record from the server (`com.atproto.repo.getRecord`), and the server's `importance`, if any, is merged into `place`.

### `describeService(): Promise<ServiceDescription>`

Returns `{ did, collections: [{ collection, metadata? }] }`. Cached for an hour.

### `getCollectionInfo(collection): Promise<CollectionInfo | null>`

Fetches the collection's metadata document. Returns `null` if the collection has no metadata link, and throws `AtgeoError` with code `CollectionNotFound` if the server doesn't list the collection.

### Errors

- `AtgeoError` has a `code` string. A non-2xx response from the server becomes an `AtgeoError` whose `code` and message come from the server's JSON error body (`error`, `message`); if there isn't one, the code is `HttpError`. The SDK adds `CollectionNotFound`.
- `searchPlaces` throws `TypeError` for an invalid region (non-finite or out-of-range coordinates, `minLat > maxLat`, negative radius) and for `sort: "similarity"` without text. It throws synchronously, before any request.
- A failed coverage request rejects the whole search. A failed tile request does not: that tile is skipped, `tiles.failed` counts it, and `complete` is `false`.
- Aborting rejects with whatever `fetch` throws. Network errors from `fetch` propagate as-is.

## Privacy

Your search text never leaves the device. Neither does your precise location.

To search, the client asks the server which tiles cover an area, downloads those tiles, and does the matching, filtering, and ranking locally. The only thing a search sends is a bounding box, and that box is snapped outward to a 0.01 degree grid (roughly 1 km of latitude) before it goes out. Your exact region is used only on the device, to filter and to compute distances.

What does go on the wire:

- `getCoverage` with the snapped bbox and the search's collection. A region that crosses the antimeridian sends two.
- Requests for the tile URLs the server returned, exactly as served, minus any already in the cache. So the server can tell which of those tiles this client fetched before — that you searched near here recently — but nothing finer than the tiles themselves.
- `describeService`, when `getCollectionInfo` or a `getPlace` cache miss needs it, and collection metadata if you call `getCollectionInfo`.
- `getPlace` on a cache miss sends the collection and rkey of the place you asked for.

The server also sees your IP address and whatever headers your `fetch` adds, as with any HTTP request. Snapping hides where in a ~1 km cell you are; it doesn't hide the cell.

## Caching

Coverage responses and the service description are cached for an hour. Tiles are cached in memory, least recently used out first, up to `cacheBudgetBytes` (measured as the tile's response length in characters). Searching a region again while its coverage and tiles are warm makes no requests at all. `getPlace` checks cached tiles before asking the server.

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
- `ranking-scenarios.json` describes regions, text, and records, and asserts which places land in the top K. It checks membership, not exact order, since the weights are likely to change.

## Server requirements

The SDK follows whatever URLs the server hands back, so a garganorn you run yourself should set `public_base` to the URL it's reachable at (e.g. `public_base: http://localhost:8000`), or `getCollectionInfo` gets links that don't resolve. Browsers can call your server directly: garganorn sends `Access-Control-Allow-Origin: *` on every route.
