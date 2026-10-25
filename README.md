# @atgeo/client

A TypeScript/ESM client for the atgeo gazetteer served by [garganorn](https://github.com/schuyler/garganorn), which searches places without telling the server what you searched for.

It runs in evergreen browsers, Node 20 or later, and workers, and has no runtime dependencies.

## Synopsis

```ts
import { AtgeoClient } from "@atgeo/client";

const atgeo = new AtgeoClient();

const { places, complete, attribution } = await atgeo.searchPlaces({
  dataset: "overturemaps.org",
  collection: "place",
  region: { lat: 39.9526, lon: -75.1652, radius: 1000 }, // meters
  text: "Starbux",
});

for (const { origin, place, collection, distance, score } of places) {
  console.log(place.name, Math.round(distance), score?.toFixed(2), origin, collection?.collection);
}

// show this wherever you show the places
console.log(attribution.map((a) => a.attribution ?? `${a.dataset}/${a.collection}`));
```

Misspellings are fine; matching is fuzzy, and that finds the Starbucks around Philadelphia's City Hall. The public server at places.atgeo.org has a limited dataset for now, mostly the east coast, so a search elsewhere may come back empty. `attribution` is who you owe credit for the data; see [Attribution](#attribution). If `complete` is `false`, some tiles failed to load and the results are partial. If `overview` is `true`, the region was too big to search in full and you got only its most important places; see [Overview answers](#overview-answers).

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
  maxBodyBytes: 8 * 1024 * 1024,        // default: 32 MiB
  requestTimeoutMs: 15_000,             // default: 30 s
});
```

Point `server` at your own garganorn to run against your own data; see [Server requirements](#server-requirements). `fetch` is for tests, proxies, or runtimes where you want to supply your own. The budget caps the in-memory tile cache (see [Caching](#caching)).

`maxBodyBytes` and `requestTimeoutMs` limit what a server can make the client do. Tile URLs come from the server, and a small gzip body can decode to gigabytes, so:

- `maxBodyBytes` caps a response body, counted in bytes after any gzip is undone. The client reads the body as a stream and stops, cancelling it, as soon as the chunk that passes the cap arrives, so what it holds grows with the cap (the bytes of one chunk past it at most, and the text decoded from them), never with how large the body claims to be. The largest tiles places.atgeo.org serves are about 2 MB. A body over the cap fails with a `BodyTooLargeError` (exported), which makes a tile a failed tile of kind `transport`.
- `requestTimeoutMs` is how long one request may take, from sending it to the last byte of the body. A stalled response and a trickled one both run out of it. The error is a `DOMException` named `TimeoutError`, the one `AbortSignal.timeout()` raises, so a tile is a failed tile of kind `transport`. Each request gets its own time, not the search as a whole.
- Both must be positive integers (`requestTimeoutMs` at most 2147483647), or the constructor throws a `TypeError`. There is no way to turn either off; pass a large number.

They apply to every request, whatever `fetch` you pass in, since they're enforced where the client reads the `Response`: an injected `fetch` gets the 30 s and 32 MiB limits by default. The timeout also reaches your `fetch` as its `signal`, alongside your own `signal` from the call, and a `fetch` that honors it can release its connection at once; one that ignores it is still cut off at the timeout (the wait for headers and the body read both end, and a response that arrives late is cancelled). Your own `signal` works the same way: aborting it rejects the call with your signal's reason, even if your `fetch` ignores `init.signal` (that wait is given up a turn after the abort). A response your `fetch` already has in hand when the abort happens is still read, if its body finishes within that turn, and its own failure (an unparsable body, say) is what you get. A `fetch` that answers after the next timer tick (`setTimeout(0)`) following the abort, or a body that is still arriving then, gets your signal's reason instead (a response that arrives by microtask or `setImmediate` is still read), and so does any body error after your abort, an oversize body (`BodyTooLargeError`) included. A runtime whose `fetch` returns a `Response` without a `body` stream (some React Native versions) is read whole, and the cap is checked after the read, so it still keeps an oversize body from reaching you but can't save the memory it took.

## API

Every method that touches the network takes an optional `signal` (`AbortSignal`).

### `searchPlaces(options): Promise<SearchResult>`

| Option | Meaning |
|---|---|
| `region` | Required. A circle or bounding box (below). |
| `text` | Optional search text. Matched fuzzily against each place's `name` and its `variants[].name`, after lowercasing and stripping accents and extra whitespace. Each name is scored against the whole query and against the query's first 12 words one at a time; words past the 12th count only in the whole-query comparison. |
| `dataset` | Required, with no default. The dataset to search, such as `openstreetmap.org` or `overturemaps.org`. |
| `collection` | Optional. Restricts the search to one collection of the dataset, such as `way`. See below. |
| `sort` | `"fused"` (default), `"distance"`, or `"similarity"`. |
| `signal` | Aborts the search. |

Regions:

```ts
{ lat: 39.9526, lon: -75.1652, radius: 1000 }    // circle; radius in meters
{ bbox: [west, south, east, north] }              // degrees
```

Datasets and collections work like this:

- With only `dataset`, you search the whole dataset, every collection together. `{ dataset: "openstreetmap.org" }` returns nodes, ways and relations in one list, and `{ dataset: "overturemaps.org" }` returns places and divisions together. Add `collection: "way"` to get only ways.
- With both, you search that collection.
- Leaving out `dataset` throws a `TypeError` before any request, and so does naming a `collection` without one. An empty string is not missing; it goes to the server, which will say it has no such dataset.

A collection-filtered search keeps only records whose `origin` starts with `urn:atgeo:{dataset}:{collection}:`. A record with no `origin` matches no collection filter, so such a search never returns one. A dataset-only search has no filter and returns those records too.

A bbox with `west > east` crosses the antimeridian. A place with a point location is kept if the point falls inside the region; a place with only a bounding box is kept if that box touches the region.

The result:

```ts
interface SearchResult {
  places: SearchHit[];
  complete: boolean;                          // false if any tile failed to load
  overview: boolean;                          // true if the server answered with its coarse overview; see below
  tiles: { fetched: number; failed: number };
  tileFailures: TileFailure[];                // one per failed tile, in tile URL order; empty if complete
  attribution: Attribution[];                 // credit for the data the search used; see Attribution below
}

interface TileFailure {
  url: string;                                // the tile URL, as the server gave it
  kind: "refused" | "status" | "decode" | "transport";
  status?: number;                            // the HTTP status, for "status" only
  error: unknown;                             // what went wrong, for you to log or inspect
}

interface Attribution {
  dataset: string;
  collection: string;
  release?: string;
  source?: string;
  licenses?: string[];
  attribution?: string;                // the credit line to show
}

interface SearchHit {
  origin: string | null;               // the place's identity: place.origin, else the tile record's uri, else null
  collection: { dataset: string; collection: string } | null; // the collection the place came from, or null; see Attribution below
  place: { [key: string]: unknown };   // the record value, exactly as served; frozen and shared with the cache (see below)
  importance: number | null;           // the record's importance, an integer, comparable across one producer's tilesets of a dataset; null if it has none
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

`place` is the gazetteer's value as served, every key and nested value unmodified. Importance lives on `hit.importance` and identity on `hit.origin`.

**`place` is shared with the client's tile cache, so it is frozen.** The object in a hit is the one the cache holds: every later search over the same tile, and `getPlace` from the cache, returns it too. To keep one app's edits from corrupting what the next search sees, the client freezes each place once, when it parses the tile (and a `getPlace` answer from the network, for consistency). Assigning to `hit.place.name`, deleting a key, or defining a property throws a `TypeError` in strict mode (ES modules are strict) and silently does nothing in sloppy mode.

The freeze is shallow. Nested objects and arrays (`locations`, `variants`, `attributes`, `relations`) are not frozen, and they are shared with the cache just the same, so `hit.place.variants.push(...)` goes through and changes what later searches return. Don't. If you want to change a place, copy it first:

```js
const mine = structuredClone(hit.place); // deep copy, safe to change
const top = { ...hit.place };            // shallow copy: top-level keys are yours, nested values are still shared
```

(It's shallow because a deep freeze made parsing a large tile markedly slower, while the shallow one costs nothing measurable.) The declared TypeScript type of `place` is still a mutable `{ [key: string]: unknown }`, so the compiler will not warn you; the runtime will.

#### Attribution

Every tile carries `attribution` entries for the collections its data comes from, and `result.attribution` is the union of them for the tiles the search used. If you show a place, show the credit its data requires. The list covers the whole search, not just the places that made it into `places`: it includes a tile whose places were all filtered out, and the *reference* entries for collections the tileset doesn't carry but whose data its places include (a place's `within` names a containing division from another collection, say). A tile that failed contributes nothing. The list is deduped by `(dataset, collection)`, and when tiles disagree about a pair, the one from the lowest tile URL wins. It is sorted by `dataset`, then `collection`, in plain code-unit order, so `Example.org` comes before `example.org`. It's an empty array, never `undefined`, when no tile had any.

`hit.collection` says which of those a place belongs to. It's `{ dataset, collection }` for the first entry in the place's own tile whose `urn:atgeo:{dataset}:{collection}:` prefix starts the place's `origin`, and `null` when no entry matches, the tile has no attribution, or the place has no `origin` (a record known only by its `uri`). The `origin` is never parsed. Look the full entry up in `result.attribution` by `(dataset, collection)`.

The entries are yours to change: they are copies, so editing one (or its `licenses`) doesn't touch the cache or what the next search returns.

#### Overview answers

When a region is too large for the server's regular tile budget and the collection has an overview, the server answers with that instead: a coarse tileset holding only the most important places. The search still runs normally over those tiles, and `overview` is `true`. The list is not everything in the region.

`overview` and `complete` are independent. `complete` says whether every tile the server named loaded; `overview` says whether the server named a thin set of tiles to begin with. An overview search whose tiles all loaded is `overview: true, complete: true`. If either half of an antimeridian-crossing search gets an overview answer, `overview` is `true`.

If `overview` is `true`, don't treat the results as exhaustive. Show something like "zoom in for more" and search a smaller region to get the full set. Collections without an overview always give `overview: false`. The SDK reads the flag from the `getTiles` response only; it doesn't guess from tile URLs.

#### Places that appear in more than one tile

A place can be stored in several tiles. The SDK keeps one hit per origin (or per `uri`, for a record with no origin). Records with neither can't be told apart, so they're never merged.

When the copies differ, which one you get is decided by tile URL: the copy from the lowest tile URL wins. Garganorn's copies of a multi-tile place are byte-identical, so this only matters for other producers' tilesets, such as an app's edited copies.

The guarantee is that the result is deterministic for the server's answers and the cache's contents, and no stronger. Which copies are present depends on which tiles a search covered, so two searches over different regions can return different copies of the same place. The rule merges copies; it doesn't decide which is correct.

### `getPlace({ origin }): Promise<PlaceRecord>`

Returns `{ origin, place, importance, attribution }`, where `place` is the value as served (frozen and shared with the cache, like `hit.place`), `importance` is a number or `null`, and `attribution` is a list of the same entries `result.attribution` holds, as served: in the server's order, duplicates and all, never undefined (empty if there are none). It's a copy. Pass the `origin` of a hit. If a cached tile holds the place, no request is made; otherwise the client asks the server (`org.atgeo.getPlace`) directly, with no discovery call first. A place with no origin is identified by its tile record's `uri`, which the cache can resolve; the server answers `PlaceNotFound` for a URI it doesn't serve, and `InvalidRequest` for a string that isn't a URI.

A cache hit returns the copy, and the attribution, from the cached tile with the lowest URL, the same rule search uses; a network answer is the server's own copy. They agree when the copies are identical, which for garganorn they are.

### `describeService(): Promise<ServiceDescription>`

Returns `{ did?, maxTiles?, tilesets: [{ slug?, collections: [{ dataset?, collection? }] }] }`. Cached for an hour. `maxTiles` is the server's tile budget; it's informational, since tile zooms are adaptive and you can't tell from it whether a box fits.

The describe calls read the server's answer leniently, so every scalar in the result is optional in the types (`did?: string`, `slug?: string`, and so on): a field the server leaves out, or sends as the wrong type, comes back absent, with no key, rather than as an `undefined` typed as a string. `tilesets`, and `collections` within a tileset or a service description, are the exceptions; they're always arrays, empty when the server sent none. List elements that can't be read are dropped, and so are fields the lexicons don't define: a newer server's extra keys don't reach you.

### `describeTileset(slug): Promise<Tileset>`

Returns the tileset's descriptor: `slug`, `collections` (each a `{ dataset, collection }` with optional `release`, `source`, `licenses`, `attribution`, `recordCount`, `locationFormats`, `containmentTypes`, `categories` and `attributes`), and optional `publishedAt`, `extent`, `references` and `overview` (`{ records? }`, how many places the tileset's coarse overview band holds; absent if it has none). Not cached. The same leniency applies.

### Errors

- `AtgeoError` has a `code` string and the HTTP `status`, which tells a request the server refused (4xx) from one it failed to answer (5xx) without matching on codes. A non-2xx response from the server becomes an `AtgeoError` whose `code` and message come from the server's JSON error body (`error`, `message`); if there isn't one, the code is `HttpError`. Apart from `HttpError`, every code comes from the server: for example `PlaceNotFound`, `TilesetNotFound`, `DatasetNotFound`, `CollectionNotFound`, `BboxTooLarge`, or `InvalidRequest` for a malformed parameter. The lexicons in `test/lexicon/` list the codes each method declares.
- `DecodingError` means the server answered 2xx with JSON that has nothing the client can use: a `getTiles` body with no `tiles` array, a `getPlace` body with no `value` object, or a describe body that isn't an object. It rejects the call, and nothing is cached. The client is otherwise tolerant: it ignores fields it doesn't read, treats a missing or wrong-typed one as absent, and skips a tile record or list entry it can't read instead of failing. A body that isn't JSON at all rejects with the `SyntaxError` from `JSON.parse`, not a `DecodingError`.
- A body over `maxBodyBytes` and a request past `requestTimeoutMs` reject unwrapped from `getTiles` (so, a search), `getPlace`, `describeService` and `describeTileset`: a `BodyTooLargeError`, or a `TimeoutError` `DOMException`. Neither is an `AtgeoError`, even for a non-2xx: an error body over the cap is a `BodyTooLargeError`, not the `AtgeoError` its status would have made. (For a tile, they are a failed tile of kind `transport`, below.)
- `searchPlaces` throws `TypeError` for an invalid region (non-finite or out-of-range coordinates, `south > north`, negative radius), for a missing `dataset` and for `sort: "similarity"` without text. It throws synchronously, before any request.
- A failed `getTiles` request rejects the whole search. A failed tile request does not: that tile is skipped, `tiles.failed` counts it, `complete` is `false`, and `tileFailures` says which tile and why. The `kind` is where it went wrong:
  - `refused`: the URL isn't an absolute `http` or `https` URL, or carries credentials (`https://user:pw@host/…`). No request is made.
  - `status`: the tile answered non-2xx. `status` is the HTTP status and `error` the `AtgeoError`.
  - `decode`: the tile answered 2xx with something that isn't a tile: not JSON, or no `records` array. A record in it that isn't usable (not an object, or with no object `value`) is skipped and doesn't fail the tile.
  - `transport`: `fetch` threw, the body couldn't be read, the body was over `maxBodyBytes` (`BodyTooLargeError`), or the request ran past `requestTimeoutMs` (a `TimeoutError`). `error` is whatever it threw, as is.

  The kind comes from which step failed, not from the error's type: a custom `fetch` that throws an `AtgeoError` of its own is still `transport`. An entry holds the tile URL and what fetching it produced, never your search text or region, and the SDK doesn't log it or send it anywhere. What you do with it is up to you.
- Aborting rejects with your signal's reason, from whatever request was in flight, and never with a timeout: when `requestTimeoutMs` runs out and your signal has not aborted, the request fails with a `TimeoutError` instead (a failed tile, if it was a tile). A call answered entirely from cache completes normally, even with an already-aborted signal. Network errors from `fetch` propagate as-is.

## Privacy

Your search text never leaves the device. Neither does your precise location.

To search, the client asks the server which tiles cover an area, downloads those tiles, and does the matching, filtering, and ranking locally. The only location a search sends is a bounding box (two across the antimeridian), snapped outward to a 0.01 degree grid (roughly 1 km of latitude) before it goes out; alongside it go the search's dataset and, if it has one, its collection. Your exact region is used only on the device, to filter and to compute distances.

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
- `lenient-readers.json` is a response body for each reader of the wire protocol (`getTiles`, a tile payload, `getPlace`, `describeService`, `describeTileset`) with what the reader keeps of it, or that it throws `DecodingError`. It pins what a port does with a missing, wrong-typed or unusable field. A tile payload's result is `{ records, attribution? }`, not a bare list.
- `attribution-scenarios.json` is a set of tiles served by a raw server, with the `attribution` and each hit's `collection` a search over them must give.
- `ranking-scenarios.json` describes regions, text, and records, and asserts which places land in the top K. It checks membership, not exact order, since the weights are likely to change. Each scenario names the `dataset` and `collection` it searches. Each record is `{ value, importance }`: `value` is an `org.atgeo.place` with an `origin`, and `importance` is an integer, as on the wire. The expectations name places by `origin`.

`docs/port-contract.md` is the language-neutral statement of what this client does, written for ports; `docs/swift-sdk-spec.md` and `docs/kotlin-sdk-spec.md` are the specifications for the Swift and Kotlin ports, `docs/python-sdk-spec.md` for the Python port, and `docs/rust-sdk-spec.md` the proposed one for Rust.

`test/lexicon/` holds copies of the wire contract's lexicon files, taken from garganorn at the commit named in `test/lexicon/SOURCE`. The test suite's fake server validates every request and response against them, so a test can't pass on a response the real server would never send. CI checks the copies against that commit (`scripts/check-fixtures.sh`); see [the port contract](docs/port-contract.md#pinning-and-the-check).

## Server requirements

The SDK needs a garganorn from the release tracked in schuyler/garganorn#27 (`getPlace` with `value` and `attribution`) that serves `org.atgeo.getTiles`, `getPlace`, `describeService` and `describeTileset`, and the dataset you name; the SDK assumes no particular dataset. It follows the tile URLs `getTiles` returns as-is. Browsers can call your server directly: garganorn sends `Access-Control-Allow-Origin: *` on every route.
