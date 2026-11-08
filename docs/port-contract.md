# Port contract

What a port of `@atgeo/client` to another language must do to be the same client. The port specs ([swift-sdk-spec.md](swift-sdk-spec.md), [kotlin-sdk-spec.md](kotlin-sdk-spec.md), [python-sdk-spec.md](python-sdk-spec.md), [rust-sdk-spec.md](rust-sdk-spec.md)) describe each port's API, packaging and idioms, and point here for behaviour, so that the SDKs can't drift apart on what a search returns.

The reference is the TypeScript source in `src/` at the commit this document was written against, the squash merge of schuyler/atgeo-sdk-js#55 (`97c776bd1dc83083cb3a72d0009deca9900beb70`). Where this document and the source disagree, the source wins and this document has a bug. The fixtures in `fixtures/` and the lexicons in `test/lexicon/` are the executable half of this contract; see [Conformance](#conformance).

"Must" marks behaviour a port has to reproduce. "Should" marks the reference behaviour where a port may do better, as long as the observable results stay the same. "May" marks a deliberate freedom.

The client is tolerant by design. It reads only the fields it needs, ignores everything else, treats a missing or wrong-typed value as absent, and never fails a search because of one record or one tile. It fails only when it cannot do the job at all: a `getTiles` call that errors or yields no usable tile list, or a `getPlace`, `searchPlaces` or describe call that errors or has no usable body. Where this document says a value "is" some type, that is what a compliant server sends; the rule next to it says what a port does when it isn't. A port must not be stricter than this document about what a response may contain, so that a server change that keeps the wire functional does not break the apps built on a port.

## 1. Wire protocol

Everything goes over HTTP GET with no request body. There are five XRPC queries and plain tile fetches.

| Call | URL | Parameters |
|---|---|---|
| getTiles | `{server}/xrpc/org.atgeo.getTiles` | `dataset`, `bbox`, and `collection` only when the search has one |
| getPlace | `{server}/xrpc/org.atgeo.getPlace` | `uri` |
| describeService | `{server}/xrpc/org.atgeo.describeService` | none |
| describeTileset | `{server}/xrpc/org.atgeo.describeTileset` | `slug` |
| searchPlaces | `{server}/xrpc/org.atgeo.searchPlaces` | `dataset`, `q`, `collection` only when the search has one, `bbox` only when a region was given (section 16) |
| tile | the URL from `getTiles.tiles`, byte for byte | none |

`{server}` is the configured server with trailing slashes removed. The default is `https://places.atgeo.org`.

Query values must be percent-encoded so the server decodes them to the exact strings. The reference uses form encoding (`URLSearchParams`), which turns `,` into `%2C` and `:` into `%3A`; a port may send those two characters raw. Space, `&`, `=`, `#`, `+` and `%` must be encoded. The reference form-encodes a space as `+`; `%20` is equally acceptable. A literal `+` must go as `%2B`, since a form-decoding server reads a raw `+` as a space.

Responses are JSON. The schemas are the lexicons in `test/lexicon/`; the ones a port reads are:

- `getTiles` → `{ tiles: string[], overview?: boolean }`. `tiles` is in ascending string order on the wire, but the client sorts anyway (section 4). Entries that are not strings are skipped. `overview` follows JavaScript truthiness, which is exactly: false when absent, `null`, `false`, `0`, `-0` or `""`, and true for any other value. A body with no `tiles` array has no usable tile list (Errors, below).
- tile payload (`org.atgeo.tilePayload`) → `{ records: [{ value, uri?, importance? }], attribution?, publishedAt? }`. Only `value`, `uri` and `importance` are kept per record. Of the payload, `attribution` is kept (below) and `publishedAt` is ignored. A record that is not an object, or whose `value` is not an object, is skipped and the tile is still used. A `uri` that is not a string, and an `importance` that is not a number, are absent.
- `getPlace` → `{ uri, url, importance?, value, attribution }`. `value` must be an object, or the response has no usable body. `importance` is read as for a tile record and `attribution` as below. `uri` and `url` are not read.
- `describeService` → `{ did, maxTiles?, tilesets: [{ slug, collections: [{ dataset, collection }] }] }`.
- `describeTileset` → `org.atgeo.defs#tileset`, which has an optional `overview: { records }`.
- `searchPlaces` → `{ places: [{ value, uri?, url?, importance?, attribution? }] }`. The body has no usable list unless it is an object whose `places` is an array. An element that is not an object, or whose `value` is not an object, is skipped. Per kept element the reader gives `origin` (`value.origin` if that is a string, else the element's `uri` if that is a string, else null), `value` (surfaced unmodified, like any `value`), `importance` (read as for a tile record) and `attribution` (an `attribution` list as below, empty unless an array). `url` is not read. Order is the served order, and nothing is deduplicated.

For the two describe calls, every field is optional on the way in. A port's typed representation treats a missing field, or one of the wrong type, as absent; a list the lexicon requires (`tilesets`, and `collections` inside a tileset) that is missing or not an array as empty, and an optional list as absent; an array element that cannot be read as dropped; and unknown fields as ignored. The lexicons say what a compliant server sends; the client must not fail because the server sends more, less, or a different type in a field the app may not even read.

An `attribution` list, in a tile payload or a `getPlace` response, holds `org.atgeo.defs#collectionAttribution` entries. In a tile payload it is optional: absent unless it is an array. In `getPlace`, which requires it, it is empty unless it is an array. An element is kept only if it is an object whose `dataset` and `collection` are both strings. Anything else is dropped, since an entry without both can't be credited to a collection. In a kept entry, `release`, `source` and `attribution` are strings or absent, and `licenses` is the string elements of an array, or absent. Each field is read on its own, and other fields are ignored. Entries keep their served order, duplicates included. A search merges them (section 4.10); `getPlace` surfaces them as read (section 9).

`value`, in a tile record and in a `getPlace` response, is an `org.atgeo.place` value and must be surfaced to the caller unmodified: every key, nested value and unknown field as served. Nothing about the schema of a place is assumed beyond what sections 5 and 7 read.

`importance` is a JSON integer on the wire, decoded through a double and range-checked into a signed 64-bit integer, so precision beyond 2^53 is lost exactly as in the reference; a port must not decode the literal exactly, or it would order huge values differently from the other SDKs. A compliant server never sends a non-integer; when one arrives it is truncated toward zero (`2.9` is 2, `-2.9` is -2, `-0.5` is 0), in the reference and in every port. A number whose magnitude is 2^63 or more is absent (the check is symmetric, so exactly -2^63 is absent too, although a signed 64-bit integer could hold it). Anything that is not a JSON number, including an array or a string holding one, is absent. None of this fails the tile. The same reading applies to `recordCount` in a collection, `count` in a category, `maxTiles` in describeService, and `records` in a tileset's `overview`.

### Errors

A non-2xx response raises the port's `AtgeoError` type with a `code` string, a `message`, and the response's HTTP `status` as an integer, so that a caller can tell a refused request (4xx) from a server failure (5xx) without matching on `code`. If the body is a JSON object whose `error` is a string, that is the code; otherwise the code is `HttpError`. If its `message` is a string, that is the message; otherwise the message is `HTTP {status}`. Each field is judged on its own, and a body that is not a JSON object has neither. The body is read before the status is checked, so a server that sends an error body with a non-2xx status is always reported with its own code.

Every code other than `HttpError` comes from the server. The lexicons declare which codes each query can return: `BboxTooLarge`, `BboxTooPrecise`, `DatasetNotFound`, `CollectionNotFound`, `InvalidBbox` for getTiles; `KeywordRequired`, `BboxTooPrecise`, `InvalidBbox`, `DatasetNotFound` and `CollectionNotFound` for searchPlaces; `PlaceNotFound` for getPlace; `TilesetNotFound` for describeTileset; `InvalidRequest` for any malformed parameter. The list is informative, not closed: a port passes any code through unchanged and never decides what to do by matching on it, so that a code the server adds later is reported, not mishandled.

A 2xx response whose body is not valid JSON, or decodes but has no usable body, raises the port's decoding error, not `AtgeoError`: the platform's JSON decoding error, or a type of the port's own where the platform's would be caught as something else (Kotlin's `SerializationException` is an `IllegalArgumentException`, the type of an argument error), except inside a tile fetch (section 4), where it counts as a failed tile. "No usable body" is the narrow list above: a `getTiles` body with no `tiles` array, a `searchPlaces` body with no `places` array, a `getPlace` body with no `value` object, a describe body that is not an object. A `getPlace` body in the earlier shape, with `record` and no `value`, has no usable body. Nothing else about a body's shape is an error.

Network failures propagate as the port's HTTP layer's own error type, unwrapped. The transport follows at least same-scheme redirects (the JVM's `HttpURLConnection` does not cross from `http` to `https`), and the response's content type is not checked.

Each contract concept is raised as these types. A port must use its column; a caller catches by type, not by message.

| Concept | JS | Swift | Kotlin | Rust | Python |
|---|---|---|---|---|---|
| Server non-2xx | `AtgeoError` | `AtgeoError` | `AtgeoException` | `Error::Atgeo(AtgeoError)` | `AtgeoError` |
| Bad argument | `TypeError` | `AtgeoArgumentError` | `IllegalArgumentException` | `Error::InvalidArgument(ArgumentError)` | `ValueError`; `TypeError` for a missing or non-string `dataset`, a non-string `keyword`, or a region of the wrong type |
| Unusable 2xx body | `DecodingError` for no usable body; `SyntaxError` for a body that is not JSON | `DecodingError` (the standard library's, `.dataCorrupted`) | `AtgeoDecodingException` (an `IOException`) | `Error::Decoding(DecodingError)` | `AtgeoDecodingError` |
| Network | whatever `fetch` raised, unwrapped; `BodyTooLargeError` or a `TimeoutError` `DOMException` from the transport's limits | the transport's error, `URLError` by default | `IOException`; `SocketTimeoutException` for a timeout | `Error::Transport(BoxError)` | whatever the transport raised; `BodyError` and `RedirectError` (both `OSError`) from the default transports |
| Cancellation | the signal's reason | `CancellationError` or `URLError(.cancelled)` | `CancellationException` | none: dropping the future cancels the call | `asyncio.CancelledError` (async client); `KeyboardInterrupt` (blocking client) |
| Autocomplete call superseded (section 19) | `AbortError` `DOMException` | `CancellationError` | `CancellationException` | `Error::Superseded` | `asyncio.CancelledError` (async client); no autocompleter in the blocking client |

A new port fills in a column of this table, with its own types, before it ships, and says in its spec where a cell has more than one type.

## 2. Client construction

Options, all optional:

| Option | Default | Meaning |
|---|---|---|
| `server` | `https://places.atgeo.org` | Base URL for XRPC calls. Trailing slashes are stripped. |
| HTTP implementation | the platform's | Injected for tests, proxies and custom networking. It must be able to fetch arbitrary absolute URLs, since tile URLs come from the server. |
| `cacheBudgetBytes` | 50 MiB (52,428,800) | Cap on the in-memory tile cache (section 10). |

A port's default transport may also take limits (section 14). The reference does, as client options: `maxBodyBytes` (32 MiB, 33,554,432, counted on decoded bytes) and `requestTimeoutMs` (30,000, one request from send to last body byte), both positive integers. They are enforced where the reference reads the `Response`, so they apply to an injected `fetch` too.

A client holds three caches (tile lists, tiles, service description) that start empty. There is no persistence. Two clients share nothing.

## 3. Regions

A region is a circle `{ lat, lon, radius }` (radius in metres) or a bounding box `[west, south, east, north]` in degrees. The port specs and READMEs use those names. Below, `minLon`, `minLat`, `maxLon` and `maxLat` name the same four values in the same order, which is also the order of the `getTiles` bbox string.

### Validation

Each searching method must reject, before any network activity and with the port's argument-error type (not `AtgeoError`), checking in the order below so that the error for a call with two faults is the same everywhere. A dynamically typed port raises its wrong-type error (Python's `TypeError`) for a `dataset`, a `keyword`, or `searchByKeyword`'s `region` of the wrong type.

`searchNearby`:

- a search with no `dataset` (section 4.1);
- a bbox where any longitude is non-finite or `|lon| > 180`, any latitude is non-finite or `|lat| > 90`, or `minLat > maxLat`;
- a circle where `lat` or `lon` fails the same checks, or `radius` is non-finite or negative;
- `sort = similarity` when the normalized text (section 7) is empty.

`searchByKeyword` (section 16):

- a search with no `dataset`, as above;
- a `keyword` that is not a string;
- a `region` that is given but is not an object with a `bbox`, so a circle is refused, or whose bbox fails the bbox checks above. A region is not given when it is absent, `undefined`, `null`, or the port's `None` or `nil`.

A keyword that cannot qualify (section 17) is not an argument error here: it goes to the server, which answers `KeywordRequired`.

`searchNearbyThenByKeyword` (section 18):

- a `dataset`, as `searchNearby`;
- a `keyword` that is not a string;
- a `keywordRegion` that is not one of the two values;
- the region, as `searchNearby`;
- `sort = similarity` when the normalized keyword is empty.

`autocompleteByKeyword` (section 19) checks `dataset` and `region` as `searchByKeyword` does, when the autocompleter is made. Its `searchByKeyword(keyword)` raises the argument error for a `keyword` that is not a string, after it has superseded the previous call.

`minLon > maxLon` is valid: the box crosses the antimeridian. `minLon == maxLon` and `minLat == maxLat` are valid (a line or a point). `radius == 0` is valid.

### Centre

The centre is used for distances (section 6) and sorting.

- Circle: `(lat, lon)`.
- Bbox: `lat = (minLat + maxLat) / 2`. If `minLon <= maxLon`, `lon = (minLon + maxLon) / 2`; otherwise `lon = (minLon + maxLon + 360) / 2`, then subtract 360 if the result is greater than 180.

Examples: `[170, 10, -170, 20]` → `(15, 180)`; `[100, 0, -100, 0]` → `(0, 180)`.

### Circle to enclosing box

With `DEG_TO_M = 111194.927`:

```
half    = radius / DEG_TO_M                    (degrees of latitude)
minLat  = max(lat - half, -90)
maxLat  = min(lat + half, 90)
sinHalfLon = sin(half°) / cos(lat°)
```

If `minLat == -90` or `maxLat == 90` or `sinHalfLon` is not strictly less than 1 (including NaN), the box is `[-180, minLat, 180, maxLat]`: the cap holds a pole, so every longitude is in play. Otherwise `halfLon = asin(sinHalfLon)` in degrees and the box is `[wrap(lon - halfLon), minLat, wrap(lon + halfLon), maxLat]` where `wrap` maps values above 180 down by 360 and below -180 up by 360. A wrapped box has `minLon > maxLon` and is split like any crossing bbox.

The longitude half-width is the spherical cap's true half-width, not `half / cos(lat)`. At high latitudes the two differ and the simpler formula misses the cap's east and west edges.

Unlike the distances of section 6, these values are snapped, so a last-bit difference can move an edge across a grid line and send a different box. A port writes each expression as the reference does, operation for operation (`sin((half * PI) / 180)`, not `sin(half * (PI / 180))`): the Python port's first transcription sent a different box for 519 of 40,000 circles chosen to put an edge near the grid. What remains is the platform's `sin`, `cos` and `asin` against V8's, which differ in the last bit on some inputs (28 of the same 40,000 against glibc). A port lists that margin in its `CONFORMANCE.md`; it changes which cell is asked for, never what the wire reveals.

### Snapping

The box that goes on the wire is snapped outward to a 0.01° grid, so that the server learns a cell, not a coordinate. Working in hundredths of a degree as integers:

```
snapDown(x): r = round(x * 100); if |x * 100 - r| < 1e-9 then r else floor(x * 100)
snapUp(x):   r = round(x * 100); if |x * 100 - r| < 1e-9 then r else ceil(x * 100)
```

`round` is any nearest-integer rounding. Its tie-breaking rule never matters, because `r` is only used when the epsilon test passes, and a tie is 0.5 away from every integer.

For each axis, `lo = snapDown(min)`, `hi = snapUp(max)`. If `lo == hi` (a point or a line), widen by one step: `hi += 1` unless `hi` is already the axis limit (9000 for latitude, 18000 for longitude), in which case `lo -= 1`. The epsilon keeps a grid-aligned input such as `37.77` from widening through floating-point error: `37.77 * 100` is `3777.0000000000005` in binary and must still snap to `3777`, where a bare `ceil` would give `3778`.

The latitude span is snapped once. The longitude is first split into segments (next heading), and each segment is snapped independently.

### Antimeridian split and the getTiles bbox strings

`lonSegments(minLon, maxLon)` is `[[minLon, maxLon]]` when `minLon <= maxLon`, else `[[minLon, 180], [-180, maxLon]]`.

The search issues one `getTiles` call per segment, in that order, with `bbox = "{lon0},{lat0},{lon1},{lat1}"` where each value is the snapped integer divided by 100 and formatted with exactly two decimals (`-122.42`, `180.00`, `0.00`). Negative zero must print as `0.00`.

Worked examples, computed with the reference implementation:

| Region | bbox strings sent |
|---|---|
| circle 37.7598, -122.4194, r 1000 | `-122.44,37.75,-122.40,37.77` |
| circle 10, 20, r 0 | `20.00,10.00,20.01,10.01` |
| circle 0, 179.999, r 5000 | `179.95,-0.05,180.00,0.05` then `-180.00,-0.05,-179.95,0.05` |
| circle 0, -179.999, r 5000 | same two as above, same order |
| circle 89.9, 0, r 50000 | `-180.00,89.45,180.00,90.00` |
| circle 80, 0, r 100000 | `-5.19,79.10,5.19,80.90` |
| circle -0, -0, r 0 | `0.00,0.00,0.01,0.01` |
| bbox [-122.42, 37.77, -122.41, 37.78] | `-122.42,37.77,-122.41,37.78` |
| bbox [-122.4194155, 37.7749295, -122.4094155, 37.7849295] | `-122.42,37.77,-122.40,37.79` |
| bbox [170, 10, -170, 20] | `170.00,10.00,180.00,20.00` then `-180.00,10.00,-170.00,20.00` |
| bbox [180, 90, 180, 90] | `179.99,89.99,180.00,90.00` |
| bbox [10, 10, 10.5, 10] | `10.00,10.00,10.50,10.01` |

Every emitted value must lie within `[-180, 180]` and `[-90, 90]`.

The snapped box must contain the caller's region. The precise coordinates must never appear on the wire in any form (section 12).

## 4. The search pipeline

`searchNearby(region, dataset, text?, collection?, sort?)` runs these steps in order. The keyword methods, which can send text to the server, are sections 16 to 19. In the TypeScript options object, order doesn't matter.

### 4.1 Resolve dataset and collection

`dataset` is required and has no default. A search without one is an argument error, raised before any request (section 3), in the port's idiom: a required parameter, a non-optional type, or a check that throws the port's argument-error type. A dynamically typed port treats a `dataset` that is not a string as missing. An empty string is a string and goes to the server, which answers for itself. With a `collection` the search covers that collection. Without one it covers the whole dataset, with no collection filter. A `collection` given without a `dataset` is the same argument error.

A dataset-only search merges every tileset the server serves for the dataset and ranks them together by importance (section 8). That is sound: the atgeo spec defines importance as comparable across the tilesets one producer builds from one dataset (garganorn `docs/atgeo-spec.md`, "Importance"; schuyler/garganorn#14).

The `collection` query parameter is sent only when the search has a collection.

### 4.2 Tile lists

For each bbox string from section 3, in order, look up the tile-list cache under the key `"{dataset}|{collection or empty}|{bbox}"`. On a miss, call `getTiles` and cache `{ tiles: the string entries of response.tiles, overview: truthy(response.overview) }` (section 1) for one hour (section 10). The calls for the two halves of a crossing region run concurrently.

If any `getTiles` call fails (server error, network, or no usable tile list), the whole search fails with that error, and nothing is cached for that key. The search does not subdivide after `BboxTooLarge`.

`overview` for the search is true if any half's list is overview.

### 4.3 Tile URLs

Take the union of every list's `tiles`, remove duplicates, and sort ascending by UTF-16 code unit comparison (plain ordinal string order; `"https://A" < "https://a" < "https://a/10" < "https://a/9" < "https://b"`). This order fixes the dedupe winner (4.6), so it must not depend on completion order or on which half of a crossing region named the tile.

### 4.4 Fetch tiles

For each URL in that order, with at most 8 fetches in flight:

- A tile in the tile cache is used without a request, and is marked recently used. Whether a port consults the cache when a worker reaches the URL (the reference) or for every URL before fetching begins affects only the order in which recency is touched, which nothing here pins.
- Otherwise fetch the URL exactly as given. On a 2xx with a body that decodes to a payload with a `records` array, keep `{ value, uri?, importance? }` per usable record (section 1: a record that is not an object, or has no object `value`, is skipped, and skipping never fails the tile) and the payload's `attribution` (section 1), store the tile in the cache with its size and attribution (section 10), and use it. The attribution is read inside the guarded decode step, and a malformed `attribution` never fails a tile, since reading it only drops entries. A tile whose every record was skipped is still a used tile with no records.
- Any other outcome (non-2xx, network error, undecodable body, a payload that is not an object, `records` absent or not an array) marks the tile failed. So does a tile URL that is not an absolute `http` or `https` URL, or that carries credentials (a non-empty username or password once parsed, by WHATWG or by any parser the port's transports use: `https://user:pw@host/…`, `https://user@host/…`, and on the JVM `https://h\@x/…`, whose `h\` `java.net.URL` reads as a user), which the reference refuses with its own check before any request. (The Fetch standard's `Request` refuses credentials, and in Node a relative URL, but accepts `data:` and `blob:` URLs and, in a browser, resolves a relative URL against the page, so `fetch` alone is not the rule.) An empty userinfo (`https://@host/…`) carries no credentials and the reference fetches it; a port may refuse it instead, since a compliant server never sends one, and says so in its `CONFORMANCE.md`. Likewise a port may refuse a URL with an `@` anywhere before its first `/`, `?` or `#` even where a backslash ends the authority first (`https://h\@x/y`, which WHATWG reads as host `h`), because an app's transport may parse the backslash as part of a user name and send credentials to `x`. It is skipped, not retried, and the search continues.
- If the search was cancelled, a tile failure is not swallowed. The reference rethrows the tile's own error, so a search aborted while a tile with an unparsable body was in flight fails with the JSON error, not the cancellation error; a port may fail with its cancellation error instead (section 14). A search that fails, cancelled or otherwise, has no result, so its tiles are never reported as failed.

What counts as a failed tile is fixed by where the error arises, not by its type. Everything that handles input from the server or the app is guarded: the URL check, the transport call (whatever the transport raises: a network error, a timeout, a body over a cap, or anything an app's transport throws), the status check, and decoding the payload and its records, however the decoder fails, since its input is the server's. The client's own work after that, storing the tile in the cache and the search's bookkeeping, is not guarded: an error there fails the search, so that a bug in the client cannot pass for a run of bad tiles. Running out of memory (Python's `MemoryError`, the JVM's `OutOfMemoryError`) fails the search wherever it arises. A decoder that overflows its stack on deeply nested JSON (Python's `RecursionError`, the JVM's `StackOverflowError`) is `decode`, since the server's input caused it; the reference's `JSON.parse` does not overflow. A port whose own work after decoding cannot fail (Rust's, where a bug panics and the panic propagates) has nothing to move out of the guard. A port must not draw the line by the error's type instead: in the reference a network failure is a `TypeError`, the type of a bug, and an app's transport may throw anything.

Each failed tile is reported in the result's `tileFailures`, in the URL order of 4.3, not in completion order:

| Field | Value |
|---|---|
| `url` | the tile URL as the tile list gave it |
| `kind` | `refused`: the URL is not an absolute `http` or `https` URL, or carries credentials, and no request was made; `status`: a non-2xx; `decode`: a 2xx whose body is not a usable tile payload; `transport`: the transport raised |
| `status` | the HTTP status for `status`, else absent |
| `error` | the port's own error for the failure: its `AtgeoError` for `status`, its decoding error or whatever the decoder raised for `decode`, the transport's error unwrapped for `transport` (except where the port's own rules convert it, as Kotlin turns a transport's stray `CancellationException` into an `IOException`; section 14), an error of the port's choosing for `refused` |

`refused` also covers a URL the port's own URL type cannot represent as the absolute http(s) URL WHATWG would read (Foundation on Linux reads a backslash in the authority differently, for one), which the port lists in its `CONFORMANCE.md`. A URL that passes the port's check and that its transport then cannot send is `transport`. So `kind` is pinned for the URLs a compliant server sends and for the refused cases above; for the odd URLs in between, each port's `CONFORMANCE.md` says what happens. A body over a size cap is `transport`, not a kind of its own: the cap belongs to the transport (section 14), an app's transport has its own cap or none, and the default transports name the cap in the error's message. A cached tile whose body fails to parse again, which a deterministic parser cannot do, is `decode`.

`url`, `kind` and `status` are part of the result and must be the same in every SDK. `error` is not: its type and message are the platform's. Where a port's result type defines equality, hashing or serialization, it leaves `error` out of them, so that two results are equal when they agree on everything this document pins. The reference's results are plain objects and are exempt. An entry is built from the tile's URL and what fetching it produced, nothing else; in particular nothing from the search text, and nothing about the region beyond what the tile URL already says (section 12). A tile URL names a tile the server chose for the snapped box, so it reveals the coarse area searched, though not the region itself.

The result's `tiles.fetched` is the number of tiles used, from cache or network. `tiles.failed` is the number that failed, which is the length of `tileFailures`. `complete` is `failed == 0`.

### 4.5 Concatenate

Concatenate the records of every used tile, in URL order (4.3), each tile's records in their served order.

### 4.6 Dedupe

A record's key is `value.origin` if that is a string, else the record's `uri` if present, else none. Walk the concatenated list keeping the first record for each key; records with no key always pass. So the copy from the lowest tile URL wins, and within a tile the first copy wins.

This happens before the region filter. If two copies of the same key differ in location and the winner lies outside the region, the place is dropped even though another copy is inside. That is the reference behaviour and a documented pothole, not something to fix in a port.

### 4.7 Collection filter

When the search has a collection, keep only records whose `value.origin` is a string starting with `urn:atgeo:{dataset}:{collection}:` (the trailing colon matters: `way` must not match `wayside`). A record with no origin is dropped. Without a collection, nothing is filtered.

### 4.8 Region filter

Keep records for which `inRegion(locate(value), region)` holds (sections 5 and 6). A record with no usable location is dropped.

### 4.9 Rank

Section 8. The result is `{ places, complete, overview, tiles: { fetched, failed }, tileFailures: [{ url, kind, status?, error }], attribution, disclosed }` (4.11). Each port spells `tileFailures` and `kind`'s values in its language's style and says so in its spec.

Warm searches: a repeat of the same region within the hour, with every tile still cached, makes no request at all. Changing only `text` or `sort` reuses everything.

### 4.10 Attribution

The result's `attribution` credits every collection whose data the search's tiles hold. It is built from every tile the search used (4.4), from the cache or the network, whether or not any of the tile's records survived 4.6 to 4.9. A failed tile contributes nothing, even if its body carries a readable `attribution`. Walk the used tiles in URL order (4.3), and each tile's entries in served order, and keep the first entry for each `(dataset, collection)` pair, compared as exact strings (no case folding). Key the pair as a tuple, not a joined string: `a|b` with `c` and `a` with `b|c` are different pairs, and so are `a:b` with `c` and `a` with `b:c`. Then sort by `dataset`, then `collection`, each in the ordinal order of 4.3. `attribution` is always present on a result, never absent or null. It is an empty list when no tile was used, or when no used tile has an attribution (a tile without one counts as an empty list).

Reference entries are included: a tileset's entries for collections it doesn't carry but whose data its records include. A hit's `within` relations carry a containing division's name, so an app that shows the hit shows that collection's data too. A tile's entries don't say which are references, and the client doesn't ask.

When two tiles' entries for one pair differ (a release, say), the lowest tile URL wins, the same rule as record dedupe. A duplicate pair within one tile: the first wins.

Each entry is surfaced with the fields section 1 kept. The app may change what it is given without changing the cache: a port either hands out immutable values or copies them.

### 4.11 Disclosure

Every search result carries `disclosed = { keyword, region }`, which says what the server learned during this one call. `keyword` is a boolean. `region` is the grid in degrees of the finest region sent during the call: `0.01`, `1`, or null for none. It is the finest only: a call that sent two regions reports the smaller grid.

For `searchNearby`, `keyword` is false. `region` is `0.01` if the call issued a `getTiles` request or attempted a tile fetch, and null if the call was answered entirely from cache. A tile URL the client refused (4.4) is not attempted; a fetch that then fails still counts. A tile list that is cached while its tiles have been evicted still fetches tiles, which tells the server the client is interested in the area again, so it reports `0.01`. A warm call reports null though an earlier call told the server about the area: the field is about the call. A call that fails returns no result and so reports nothing.

## 5. Reading a place's location

`locate(value)` returns `{ point?, bbox? }` from `value.locations`, which must be an array for anything to be found:

- `point` is the first element with `$type == "community.lexicon.location.geo"` whose `latitude` and `longitude` parse to finite numbers.
- `bbox` is the first element with `$type == "community.lexicon.location.bbox"` whose `south`, `north`, `east`, `west` all parse to finite numbers; it is stored as `{ south, north, west, east, segments: lonSegments(west, east) }`, so a box with `west > east` crosses the antimeridian. The parsed `west` and `east` are kept, as parsed, so that a hit's `location.bbox` can report the box in the lexicon's names (section 8).

Both may be present. Elements with other `$type`s, and elements whose numbers don't parse, are skipped (a non-parsing geo element does not stop a later geo element from being the point). An element that is not a JSON object is skipped too, `null` included. Coordinates are not range-checked: a latitude of 95 or a longitude of 200 is kept as parsed and the geometry of section 6 is applied to it as is.

Parsing: the lexicon types these as strings; the reference applies JavaScript `parseFloat` to a JSON string and reads a JSON number as it is, so a number works too. A port must accept a JSON string holding a decimal number (optional sign, optional fraction, optional exponent) and a JSON number. Any other JSON type (`null`, a boolean, an array, an object) is no number, so `latitude: [0.5]` is not a coordinate. It may reject what `parseFloat` would partially accept (leading whitespace, trailing garbage such as `"1.5abc"`), and a port's own number parser may accept forms `parseFloat` does not (hex floats, a trailing `f`). These margins are a known, documented divergence between the SDKs rather than something to make exact, because garganorn emits none of them; a port lists the forms its parser treats differently in its `CONFORMANCE.md`. `Infinity`, `NaN` and the like are non-finite and are skipped.

A longitude bbox element may be given with `west > east`, and `±180` are the same meridian.

## 6. Distance and containment

Constants: `EARTH_RADIUS_M = 6371008.8`.

`haversine(lat1, lon1, lat2, lon2)` in metres: standard, `2R·asin(min(1, sqrt(a)))`. One degree of latitude at the equator is `111195.0802335329` m; San Francisco (37.7749, -122.4194) to Los Angeles (34.0522, -118.2437) is `559121.3493517868` m.

`covers(south, north, segments, lat, lon)`: false if `lat < south` or `lat > north`; otherwise true if `|lat| == 90` (every meridian meets at a pole), or `lon` lies in a segment, or `|lon| == 180` and `-lon` lies in a segment. Segment membership is inclusive.

`distanceTo(locations, lat, lon)`, metres from the centre to the nearest point of the place, or null without a location:

1. Containment first, so it returns exactly 0 and not round-trip noise: with a point, contained means `covers(point.lat, point.lat, [[point.lon, point.lon]], lat, lon)`; otherwise with a bbox, `covers(bbox.south, bbox.north, bbox.segments, lat, lon)`. If contained, return 0.
2. With a point, return `haversine(lat, lon, point.lat, point.lon)`.
3. Without a bbox, return null.
4. Otherwise the box is off to one side. Let `lonStar` be `lon` if it lies in a segment, else the segment endpoint with the smallest angular gap to `lon` (`gap(a, b) = min(d, 360 - d)` with `d = |a - b| mod 360`; on an exact tie the first endpoint in segment order wins). Along that meridian, the closest latitude of the great circle through the centre is `phiC = atan2(sin φ0, cos φ0 · cos Δλ)` with `φ0 = lat` and `Δλ = gap(lonStar, lon)`, in radians. Return the minimum of the haversine distances from the centre to `(clamp(phiC, south, north), lonStar)`, `(south, lonStar)` and `(north, lonStar)`.

Worked examples (centre as `lat, lon`; box as `north, south, east, west`):

| Place | Centre | Metres |
|---|---|---|
| point 0.001, 0 | 0, 0 | 111.19508023353292 |
| box 46, 44, 11, 9 | 45, 10 | 0 |
| box 46, 44, 11, 9 | 45, 8 | 78624.79923702011 |
| box 46, 44, 11, 9 | 47, 10 | 111195.0802335329 |
| box 46, 44, 11, 9 | 47, 8 | 134989.80127268212 |
| box 80, 70, 30, 10 | 75, 60 | 826787.9307589367 |
| box 50, 40, -170, -180 | 45, 180 | 0 |
| box 10, -10, -170, 170 | 0, 160 | 1111950.8023353291 |
| no location | any | null |

A port is not expected to be bit-identical in trigonometry across runtimes; agreement to 1e-6 relative is the conformance bar. Containment, which is decided by comparisons, must be exact.

`inRegion(locations, region)`:

- Bbox region `[minLon, minLat, maxLon, maxLat]` with `segments = lonSegments(minLon, maxLon)`: with a point, `covers(minLat, maxLat, segments, point.lat, point.lon)` (a point on the boundary is inside; a place with both a point and a box is judged on the point alone). Without a point but with a box, `meets(box, minLat, maxLat, segments)`: the latitude spans must overlap (`max(box.south, minLat) <= min(box.north, maxLat)`), and then either that overlap touches a pole (`hi == 90` or `lo == -90`), or the longitude segments overlap, where the place's segments are augmented so that one ending at 180 also counts as `[-180, -180]` and one starting at -180 also counts as `[180, 180]`. Overlap of two segments is `alo <= bhi && blo <= ahi`.
- Circle region: `d = distanceTo(locations, lat, lon)`; inside if `d` is not null and `d <= radius`. The true radius, not the enclosing square: a point 111.195 m north of the centre is inside a 111.2 m circle and outside a 111.1 m one.

## 7. Text matching

### Normalization

`normalize(s)`, in this order:

1. Lowercase with Unicode default (locale-independent) full case mapping. `İ` (U+0130) becomes `i` + U+0307; `ΟΔΟΣ` becomes `οδος` with a final sigma (U+03C2); `ẞ` becomes `ß`.
2. NFKD. Ligatures and full-width forms decompose: `ﬁsh` → `fish`, `ＡＢＣ` → `abc`, `①` → `1`, `½` → `1⁄2`.
3. Lowercase again, with the same mapping. Some compatibility characters are capitals with no lowercase mapping of their own, so step 1 leaves them and step 2 turns them into ordinary capitals: `ℌ` (U+210C) and the mathematical letters such as `𝐇` (U+1D407) become `H`. Without this step `ℌello` would normalize to `Hello` and never match the query `hello`. On text that step 2 left lowercase it changes nothing, so it only affects such characters. Final_Sigma applies here as in step 1: `𝚺𝚨𝚺` → `σας`.
4. Remove every scalar whose general category is Mn (nonspacing mark). This strips the accents NFKD split off: `café` → `cafe`, and the dot from `İ`, giving `istanbul`. Mc and Me marks stay (`a` + U+20DD is unchanged).
5. Replace every run of one or more whitespace scalars with a single U+0020, then strip leading and trailing whitespace. The whitespace set is exactly JavaScript's `\s`: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. U+200B (zero-width space) and U+0085 are not in it. Ideographic space counts, so `　東京　` → `東京`.

`fixtures/normalize.json` must pass exactly. Runtimes disagree on Unicode versions at the margins; the fixture is the arbiter. It covers the final sigma, `İ` and `ẞ` cases above, and two abbreviations (`Α.Σ.` → `α.ς.`, `ΑΣ.Α` → `ασ.α`) that pin Final_Sigma's skipping of case-ignorable punctuation on both sides of the sigma, and the step 3 cases. Swift's standard library does not apply Final_Sigma; the Swift spec says how that port does.

The search text and every candidate name are normalized with this function. Empty text after normalization means no text: no scoring, no filtering, and `sort = similarity` is an error.

### Jaro-Winkler

Strings are compared as sequences of UTF-16 code units, not scalars or grapheme clusters, and lengths are code-unit counts. This is what the reference does and the fixtures assume. The difference is observable: `jaroWinkler("😀😁", "😀😂")` is `0.8833333333333334` by code units (each emoji is a surrogate pair, so the strings share three of four units), where comparing scalars would give `0.7`.

```
jaro(a, b):
  if a == b: 1
  if either is empty: 0
  reach = max(0, floor(max(|a|, |b|) / 2) - 1)
  for i in 0..<|a|: for j from max(0, i - reach) to min(|b| - 1, i + reach) inclusive, skipping the loop when the start exceeds the end:
    if b[j] unmatched and a[i] == b[j]: mark both matched, matches++, break
  if matches == 0: 0
  transpositions: walk matched positions of a and b in order, count i where a[i] != b[j]
  (matches/|a| + matches/|b| + (matches - transpositions/2)/matches) / 3

jaroWinkler(a, b):
  prefix = length of common prefix, capped at 4
  jaro + prefix * 0.1 * (1 - jaro)
```

Every division is in floating point. `transpositions` can be odd (`abcvwxyz` against `cabvwxyz` has three), so an integer `transpositions / 2` fails the fixture.

The inner loop's start exceeds its end whenever `|a| > |b| + reach` (`starbux` against `bar`), and the loop must then run zero times. The Jaro-Winkler fixture never triggers this, so a port that traps on an empty range (Swift's closed-range operator does) passes 33/33 and then crashes in the ranking fixture's `Starbux` scenario. Write it as a guarded `while`.

`fixtures/jaro-winkler.json` gives scores to six decimals; a port must match to within 5e-7. That is exactly the rounding budget, with no headroom: the algorithm is rational arithmetic in doubles, so a straight transcription lands within 1e-15 of the reference before rounding, and the JVM transcription's worst distance from the fixture is 4.8e-7.

### Scoring a record

```
tokens = first 12 space-separated words of the normalized query
scoreName(query, tokens, name):
  nameTokens = name split on " "
  tokenScore = mean over t in tokens of ( max over n in nameTokens of jaroWinkler(t, n) )
  0.5 * jaroWinkler(query, name) + 0.5 * tokenScore

textScore(query, value):
  names = [value.name] + [v.name for v in value.variants]   (only string values, normalized, non-empty)
  max(0, max over names of scoreName(query, tokens, name))
```

Words past the twelfth count only in the whole-query comparison. `variants` must be an array for its names to count; a variant that is not an object (`null` included), or whose `name` is not a string, is skipped.

A record whose score is below `0.6` is dropped (exactly 0.6 is kept). Without text, the score is null and nothing is dropped.

Examples with the reference: for query `Starbux`, `Starbucks` scores `0.9048`, `Star Bakery` `0.8740`, `Stardust Bar` `0.8530`, and `Home Depot` is dropped. For `Munich`, a place named `München` with variant `Munich` scores `1`.

### Match tier

A record that cleared the threshold has a match tier: 1 if the text matches one of its names word for word (each query word begins a word of that name), 2 if it matches only fuzzily. Ranking sorts by tier first (section 8). The tier is computed only for records that scored at least 0.6, and only when there is text.

```
fold(s):
  remove U+0027, U+2019 and U+02BC from s
  replace each run of scalars whose general category is P* (Pc Pd Ps Pe Pi Pf Po) with one U+0020
  split on U+0020 and drop the empty strings

queryTokens = concatenation of fold(w) for w in the first 12 space-separated words of the normalized query

tier(query, value):
  if queryTokens is empty: 1
  for each name in names (the list textScore uses):
    nameTokens = fold(name)
    if every q in queryTokens is a prefix of some n in nameTokens: return 1
  return 2
```

Apostrophes are removed, not split on, so `mcdonalds` matches `McDonald's`. Other punctuation splits, so `st louis` matches `St. Louis`, `saint germain` matches `Saint-Germain`, and `at&t` folds to `at t` on both sides. A symbol (general category S*, such as `+` or `$`) is not punctuation and does not split. The same fold applies to the query and to every name.

A word that folds to nothing still uses its slot among the twelve. A query whose tokens all fold away (`&`) has no tokens, so every hit is tier 1. All tokens must prefix words of one name; tokens may not be spread over a name and a variant.

Prefix means a prefix in UTF-16 code units, as in Jaro-Winkler. A port must not use a grapheme-wise `hasPrefix` (Swift's `String.hasPrefix`): the query `क` is a prefix of the name `कि` (U+0915 U+093F, where U+093F is a spacing mark that normalization keeps), and the fixture pins that.

`fixtures/match-tiers.json` must pass exactly. Each case is `{ name, query, place: { name, variants? }, tier }`, with raw strings. A runner normalizes `query` (section 7), builds the place value from `place` (`variants` is a list of `{ name }`), calls the port's internal tier function on the normalized query and that place, and compares the result with `tier`.

`fixtures/match-tiers-lone-surrogates.json` has the same shape. Its strings hold lone surrogates, which is where a code-point prefix and a code-unit prefix disagree: a high surrogate on its own is a code-unit prefix of the astral character it would pair into. A port whose string type can hold a lone surrogate (JavaScript, Python, Kotlin) must pass it. A port whose string type cannot (Rust, Swift) vendors it, does not run it, and says so in its `CONFORMANCE.md`; such a port reads a lone surrogate escape in a body as U+FFFD, and neither a body nor an app's text can give it one, so the case cannot reach its tier function.

## 8. Ranking

For each surviving record build a hit:

| Field | Value |
|---|---|
| `origin` | the record key (section 4.6), or null |
| `collection` | a new object holding exactly `{ dataset, collection }` (no other field of the entry, and not the entry itself) of the first entry, in served order, of the `attribution` of the tile the record came from (the tile whose copy 4.6 kept). The entry is the first one for which `value.origin` is a string starting with `urn:atgeo:{dataset}:{collection}:`, the test of 4.7. It is null when no entry matches, when the tile has no attribution, or when `value.origin` is not a string (a record keyed by its `uri`). The origin is never split. A tile without an attribution counts as an empty list here. `collection` is always present on a hit: an object or null, never absent. |
| `place` | `value`, untouched |
| `importance` | the record's `importance`, or null |
| `distance` | `distanceTo(locate(value), centre)` in metres; never null here, since the region filter already required a location |
| `score` | `textScore`, or null without text |
| `via` | `"tiles"` |
| `name` | `value.name` when that is a string, else null |
| `location` | `{ point, bbox }` as section 5 reads it, in the lexicon's field names: `point` is `{ lat, lon }` or null, `bbox` is `{ south, west, north, east }` or null. A box with `west > east` is kept as it is read and crosses the antimeridian. |

Before the hits are sorted, with text and a result `overview` of true (4.2: true if either half's list is an overview), every hit with tier 2 is removed. This holds in every sort mode. The overview answer is the OR across tile lists, so in an antimeridian-split search where either half is an overview, fuzzy hits are dropped from both halves. Without text, or without `overview`, nothing is removed.

Internally each hit also carries `specificity`: 0 for a hit with a point or no bbox, else the box's relative spherical area `(sin north - sin south) · Σ(hi - lo)` over its segments, in radians. It also carries `tier`: 1 or 2 with text, null without (section 7). Neither is part of the result.

Comparators, each returning negative when `a` sorts first:

- `byTier`: `a.tier - b.tier`, where null ties with null. Exact matches first.
- `byScore`: `round3(b.score ?? 0) - round3(a.score ?? 0)`, with `round3(x) = round(x * 1000) / 1000`, round half away from zero (scores are non-negative). Best first; scores that differ only past the third decimal tie.
- `byImportance`: `(b.importance ?? 0) - (a.importance ?? 0)`. Larger first. A null importance sorts as 0: above negatives, tied with 0. Importance is comparable across one producer's tilesets for one dataset (section 4.1), which makes this comparator sound for a dataset-only search.
- `byDistance`: `a.distance - b.distance`. Nearest first.
- `bySpecificity`: `a.specificity - b.specificity`. Smaller first.
- `byOrigin`: equal origins tie; a null origin sorts after any string; otherwise ordinal string comparison.

Sort modes:

| Mode | Order |
|---|---|
| `fused` (default) | tier, score, importance, distance, origin |
| `distance` | tier, distance, specificity, importance, score, origin |
| `similarity` | tier, score, distance, origin |

Tier comes first in every mode: exact matches nearest-first, then fuzzy matches nearest-first, in `distance`. Without text every tier is null, so the order without text is unchanged.

`place` on a hit is the record's value, and the record is the one the tile cache holds (sections 4.5 to 4.9 pass it through), so it may be shared with the cache, with later searches and with `getPlace`. A port must either hand the app an immutable view of it or document that the app must not change it; the reference freezes it (section 9). The same holds for `location`: a port that hands out mutable values freezes or copies it, with its `point` and `bbox`, as for `place`. The reference freezes all three.

The sort must be stable: hits that tie on every comparator (only possible when both lack an origin, since dedupe leaves one hit per origin) keep their order from section 4.5. A port that cannot rely on its library sort being stable must add the input index as a final tie-break.

`fixtures/ranking-scenarios.json` must pass: for each scenario, run the records through sections 4.6 to 4.9 as a search of the scenario's `dataset` and `collection` (no network) and check that each `expect.top[k].origins` set is a subset of the first `k` hits' origins and each `expect.absent` origin is not in the result at all. The fixture checks membership, not order. A scenario may carry `"overview": true`, which the runner's fake server returns from `getTiles`, so that the overview drop is exercised.

## 9. The other calls

The SDK's `origin` is the wire's record key: the `uri` parameter of `getPlace`, which its response echoes as `uri`. The SDK's `place` is the wire's `value`, in a tile record and in a `getPlace` response alike.

`place` in a `getPlace` answer may likewise be the cached record's own value, so the rule from section 8 applies: make it immutable or document it. The reference freezes the value once, shallowly, when it parses the tile or the `getPlace` response, so every place it hands out is frozen, whether it came from the cache or the network; nested values stay mutable and shared, and the README says so and gives the copy recipe. A port whose language has value or immutable types needs no such step.

`getPlace(origin)`: search the tile cache for a record whose key (4.6) equals `origin`; if several cached tiles hold one, take the record from the lowest tile URL. The scan does not mark any tile recently used (section 10). On a hit return `{ origin, place: value, name, location, importance ?? null, attribution }` with no request, where `attribution` is the source tile's `attribution` as read (section 1), or empty when the tile has none (absent, or not an array). That tile is the lowest-URL one holding the record. On a miss call `getPlace` with `uri = origin` (no `describeService` first) and return `{ origin, place: value, name, location, importance ?? null, attribution }`, where `attribution` is the response's `attribution` as read (section 1). Neither is merged or sorted: it keeps served order, duplicates included. On both paths `name` and `location` are built from `value` as for a hit (section 8), and `attribution` is always a list, never absent or null. The returned `origin` is the caller's string, not the response's `uri`. For garganorn the two paths agree, since `getPlace` answers with the attribution of the place's tileset, which is the list every tile of that tileset carries.

`attribution` in a `getPlace` answer, from the cache or the network, and in a search result (4.10) is the app's own. A port either hands out immutable values or copies them, so an app that changes an entry or its `licenses` list changes neither the cached tile nor a later search's or `getPlace`'s answer. The reference copies each entry and its `licenses` array per answer.

`describeService()`: cached for one hour; otherwise one request. Returned as decoded, leniently (section 1). That includes `maxTiles`, the server's tile budget. It is informational: tile zooms are adaptive, so a client can't tell from it whether a box fits.

`describeTileset(slug)`: never cached; one request per call. Returned as decoded, leniently (section 1), including `overview`. It is absent when the tileset has no overview band, or when the field is not an object. When present it is an object whose `records`, the number of records in the band, is read as in section 1 and is absent when unreadable. Unknown fields in it are ignored.

## 10. Caching

Three caches, all in memory, none persisted, none shared between clients.

- Tile lists: key from 4.2, value `{ tiles, overview }`, expires 3,600,000 ms after being set, by wall-clock time: an entry is fresh while `now < set + 3,600,000` and a miss from exactly that instant on. Entries need not be evicted on expiry, but a port may prune them.
- Service description: one entry, same one-hour expiry.
- Tiles: keyed by URL, each holding its usable records and its `attribution` (section 1), so a warm search (4.10) and the `getPlace` scan (section 9) have it without a request. LRU, capped by `cacheBudgetBytes`. A tile's size is the length of its response body; the reference counts UTF-16 code units of the text, a port counts bytes. Reading a tile by URL during a search marks it most recently used; the `getPlace` scan (section 9) does not. Inserting a tile adds its size and then evicts least recently used tiles until the total is within budget (a single tile larger than the budget evicts every other tile and then itself, so the cache never exceeds the budget after an insert). Replacing a URL subtracts the old size first. A port may hold each tile's body and parse it again when it is read, and may keep the parsed records of some tiles outside the budget as a memo, because a parsed tile can take several times its body size in memory; what is fetched, and when, and the recency order must be exactly as without the memo. A port that holds bodies and parses them again parses the attribution again too. A tile's size is still its body length; the attribution is part of the body.

Keyword calls (`searchByKeyword`, the keyword request of the fallback, and every autocompleter call) are not cached: each is exactly one request, and nothing from the answer enters any cache. `getPlace` on a keyword hit's origin consults the tile cache and then the network, as for any origin.

Expiry tests set the clock, so a port must take its time source from somewhere a test can control.

## 11. Cancellation

Every network-touching call accepts the platform's cancellation mechanism. Cancellation surfaces as the platform's cancellation error, from whatever request was in flight. In the reference, a call answered entirely from cache completes normally even when already cancelled; a port should match this, but it is not a conformance requirement.

An autocompleter's call (section 19) honours the caller's own cancellation as well as its own supersession: a caller that cancels its call gets the port's cancellation outcome, even if the autocompleter supersedes it afterwards. A port arranges that the call is a child of the caller's task, or wraps it in its cancellation handler, or combines the two signals. A call the autocompleter has superseded has already ended with the supersession outcome, so a later abort by the caller changes nothing.

## 12. Privacy invariants

These are what the client is for. The naming rule holds them together: a method whose name contains `Keyword` may send search text to the server, and no other method does. The option that carries text is `text` where it never leaves the device and `keyword` where it may. Items 1 to 4 and 6 to 9 must be covered by tests against a request-capturing fake server; item 5, which is about the default transport the fake replaces, by that transport's loopback test.

Items 1 to 3 are `searchNearby`'s, and the nearby half of `searchNearbyThenByKeyword` is bound by them too:

1. The search text never appears on the wire: not raw, not normalized, not any of its words, not URL-encoded, not in a header, not in a body, in any case folding. Test with text such as `Zanzibar Quokka`, `  ZANZIBÁR   quokka `, and check every request's URL (raw and percent-decoded), headers and body for the text, its trimmed and lowercased forms, the normalized form, each normalized word, and prefixes such as `zanzib`.
2. A search issues only `getTiles` and tile requests, all GET, with no body.
3. Precise coordinates never appear on the wire. For a circle at `37.7749295, -122.4194155` with radius `123.456789`, none of `37.7749295`, `122.4194155`, `7749295`, `4194155`, `123.456789` appears in any request. For a bbox of full-precision corners, none of the corner digit strings appears.
4. `getPlace` on a cache miss sends the origin and nothing else.
5. A port's default transport sends a fixed `User-Agent` naming the port and nothing else, with no version (`atgeo-client-kotlin`, `atgeo-client-swift`), the same on every request and every device, in place of the platform's default, which can name the OS release and the device model (Android's `http.agent` does). A version would split users by app update. It sends no `Accept-Language` derived from the user's locale: either none, or a fixed `*`. URLSession adds one from the locale (`en-US,en;q=0.9` on Apple platforms, `en` on Linux) unless the request sets its own. The fake server replaces the transport, so the transport's own loopback test asserts both, on whatever platforms the port's CI can run it; where it can't (Kotlin on Android), the port's spec says how the platform's behaviour was established. The reference is exempt: its runtime's `fetch` sends values that are fixed for the runtime (Node 22's sends `User-Agent: node` and `Accept-Language: *`), and in a browser or a worker both headers are the runtime's, the same for every site. A transport the app supplies sends whatever its HTTP stack does, and the port's README says so.
6. `searchByKeyword` issues one GET, `searchPlaces`, whose parameters are exactly `dataset`, `collection` only if given, `q` (the keyword exactly as passed) and `bbox` only if a region was given, and no other request. The `bbox` is four whole numbers and matches `^-?\d+,-?\d+,-?\d+,-?\d+$`. No digit string of a precise region's coordinates appears in any request: for `[-122.4194155, 37.7749295, -122.4094155, 37.7849295]` none of `7749295`, `4194155`, `4094155`, `7849295` does.
7. `searchNearbyThenByKeyword` sends the keyword only when the nearby results have no tier-1 hit and the keyword qualifies (section 17). When a nearby hit is tier 1, or the keyword cannot qualify, no `searchPlaces` request is made and the keyword is not on the wire in any form (the checks of item 1 apply to every request). When it is sent, it is sent as `searchByKeyword` sends it, with `bbox` present for `keywordRegion = "degree"` and absent for `"none"`.
8. An `autocompleteByKeyword` call with a keyword that cannot qualify sends nothing. One that qualifies sends exactly what `searchByKeyword` does, for every string, prefixes included.
9. `disclosed` agrees with the captured requests: `keyword` is true exactly when a `searchPlaces` request was made, and `region` is the finest grid among the regions that went out.

Diagnostics stay in the app's process. A port sends no telemetry and no error report, to the server or anywhere else. A failed-tile entry (section 4.4) or a log line (section 14) carries a tile URL, which the server chose and the app may see, and what fetching it produced; never the search text in any form, nor the region or the bbox strings of section 3. A tile URL reveals the coarse area searched, so a port that logs one marks it private where its logging facility has such a notion.

## 13. Conformance

A port vendors, at a pinned atgeo-sdk-js commit recorded in a `SOURCE` file:

- `fixtures/normalize.json` (41 cases, exact match),
- `fixtures/jaro-winkler.json` (33 cases, within 5e-7),
- `fixtures/ranking-scenarios.json` (19 scenarios, membership). Each scenario names the `dataset` and `collection` it is a search of, and the runner passes them (section 8).
- `fixtures/match-tiers.json` (36 cases, exact match): the tier of section 7 for a query and a place, described there.
- `fixtures/match-tiers-lone-surrogates.json` (4 cases, exact match, run only where a string can hold a lone surrogate): the same, for queries and names with lone surrogates.
- `fixtures/lenient-readers.json` (124 cases, exact match): a response body for each of the six readers of section 1 (`getTiles`, a tile payload, `getPlace`, `searchPlaces`, `describeService`, `describeTileset`) and either what a port's reader keeps of it or `decodingError`. A missing key is an absent field. The expected values are in JSON terms, so a port maps them onto its own types. The `tilePayload` result is an object, `{ "records": [...], "attribution": [...] }`, where `attribution` is a missing key when the reader leaves it absent (section 1). The `getPlace` bodies and results use `value` and `attribution` (every non-error result has an `attribution` list), and the describe cases cover `maxTiles` and `overview`. The `searchPlaces` result is `{ "places": [{ "origin", "value", "importance"?, "attribution" }] }`, with `origin` null when neither the value's `origin` nor the element's `uri` is a string and `importance` a missing key when absent.
- `fixtures/attribution-scenarios.json` (12 scenarios, exact match): `NearbySearchResult.attribution` and `NearbyHit.collection` (sections 4.10 and 8), described below.
- `fixtures/keyword-fallback.json` (6 scenarios, exact match): the solid-hit decision, the merge and `disclosed` of `searchNearbyThenByKeyword` (section 18), described below.
- `fixtures/keyword-regions.json` (72 cases, exact match): the `bbox` string a keyword search sends for an input bbox (section 16), described below.
- `test/lexicon/*.json`, for a fake server that validates its own traffic.

### The attribution scenarios

Each scenario is `{ name, description, dataset, collection?, region, tiles: [{ url, body?, status? }], expect: { attribution, hits: [{ origin, collection }] } }`. The tile bodies need not validate against the lexicons, so the runner uses a raw server, not a validating fake. The reference's `test/attribution.test.ts` runs it like this, and a port's runner does the same:

- A fresh client per scenario. Scenarios reuse tile URLs (`a.json`, `b.json`) with different bodies, and the tile-list cache key is `{dataset}|{collection}|{bbox}`, so a shared client would serve one scenario's cached lists and tiles to the next.
- The base server is `https://places.atgeo.org`. The raw server routes `https://places.atgeo.org/xrpc/org.atgeo.getTiles` (any query) separately from the absolute tile URLs, which it matches exactly. It answers every `getTiles` call with `{ "tiles": [the scenario's tile URLs, in listed order] }`. The listed order is deliberately not sorted, which exercises 4.3.
- Each tile is served with its `body` verbatim and its `status` (default 200). A tile with a `status` and no `body` gets the default error body `{"error":"InternalServerError","message":"upstream error"}`, which makes a `status: 500` tile a failed tile of kind `status`. A 200 tile whose body is not a usable payload is a failed tile of kind `decode`.
- The search has no text and the default sort. It passes the scenario's `dataset`, its `collection` when it has one, and its `region`.
- `result.attribution` must deep-equal `expect.attribution`, in order, with a field the scenario leaves out being a missing key in the result.
- The hits are compared as a multiset of `(origin, collection)` pairs, order-insensitive, against `expect.hits`. Every hit must carry the `collection` key: a null is `null`, never a missing key. Each `collection` is compared with strict equality, so a port that hands back the whole entry, with its `release` or `licenses`, fails. The scenarios' entries carry those extra fields on purpose.

Three things the fixtures do not pin:

- **Ordinal order above U+FFFF.** The sort in 4.10 uses the comparator of 4.3, which compares UTF-16 code units. No fixture has a name outside the basic multilingual plane, so nothing here fails a port that sorts differently. Python, Rust and Swift compare strings by code point or byte by default, which differs from UTF-16 order above U+FFFF. A port must use its 4.3 comparator for the attribution sort too.
- **Tile arrival order.** A fixture is data, and cannot say which tile arrives first. The union and the dedupe of 4.10 follow tile URL order whatever order the tiles arrive in, so each port needs a test of its own that delays the lowest URL's response and checks the result is unchanged. The reference's is `attribution.test.ts`, "attribution scenarios, tiles arriving in reverse URL order": it reruns every scenario with more than one tile, delaying each response so the highest URL arrives first, and checks the same attribution and hits.
- **Cache and copy behaviour.** Warm searches, `getPlace` from the cache and the copy rule of section 9 are tested in `cache.test.ts`, `client.test.ts` and `frozenPlace.test.ts`; a port needs equivalents.

### The keyword scenarios

`keyword-fallback.json` holds scenarios of `{ name, description, dataset, collection?, region, keyword, keywordRegion, sort?, tiles: [{ url, body }], keywordAnswer, expect: { keywordRequested, bbox?, origins, disclosed } }`. `keywordAnswer` is a `searchPlaces` body. They cover a tier-1 nearby hit (no request), tier-2 hits only (a request, the merge order, the dedupe), no nearby hits, an unqualified keyword (no request), `"none"` against `"degree"`, and a circle region's snapped box with a collection. The bodies need not validate against the lexicons, so the runner uses a raw request-capturing server, as the attribution scenarios do:

- A fresh client per scenario, for the reason given there.
- The base server is `https://places.atgeo.org`. `getTiles` (any query) is answered with the scenario's tile URLs in listed order, each tile is served with its `body`, and `searchPlaces` (any query) is answered with `keywordAnswer`. Every request is recorded.
- The call passes the scenario's `dataset`, `collection` when it has one, `region`, `keyword`, `keywordRegion` and `sort` when it has one.
- The origins of the result's places must equal `expect.origins`, in order: the merge is fully specified, so unlike ranking the order is checked. The scenarios keep the nearby part to clear orderings so the ranking weights stay free, and circles well away from whole-degree lines so that last-bit trigonometry cannot move an edge.
- `result.disclosed` must equal `expect.disclosed`. The number of `searchPlaces` requests is 1 when `expect.keywordRequested` and 0 otherwise, and a request's parameters are exactly `dataset`, `collection` when given, `q` as the keyword, and `bbox` when `expect.bbox` is present, equal to it.

`keyword-regions.json` holds cases of `{ name, bbox, sent }`. The cases list every seam rather than sampling them: fractional and whole-number boxes, zero-width spans (including at 0, +/-180 and +/-90), polar boxes, a west or east edge of exactly +/-180 in crossing and non-crossing boxes (`[180, …, -180, …]` included), crossing boxes with every sign combination, and widths near 360 degrees. The runner sends each `bbox` as the region of a `searchByKeyword` call to a fake server that refuses what the real server refuses (`BboxTooPrecise` and `InvalidBbox`, section 16), and asserts that the one request's `bbox` parameter equals `sent`. A case passes only if the fake accepted what was sent, so the fixture's arithmetic is checked against the server's rules independently. Each `sent` also matches `^(0|-?[1-9]\d*)(,(0|-?[1-9]\d*)){3}$`: plain integers, no `-0`, no `.0`.

### Pinning and the check

A `SOURCE` file records where a vendored directory came from, one line per upstream:

```
atgeo-sdk-js <40-hex commit> fixtures/
garganorn <40-hex commit> garganorn/lexicon/
```

The first field is the repository (`atgeo-sdk-js` or `garganorn`), the second the full commit SHA, and the third the directory in that repository the files were copied from. Blank lines and lines starting with `#` are skipped, and anything after the third field is ignored, so a note or a parenthetical there (Swift's `(from atgeo-sdk-js test/lexicon/SOURCE)`) is fine. The fixtures directory's `SOURCE` has the `atgeo-sdk-js` line. The lexicon copy takes its `garganorn` line from its own `SOURCE` (`lexicon/SOURCE` next to the fixtures, or `test/lexicon/SOURCE` here), or, in a port that keeps both in one directory, from the fixtures' `SOURCE`. A pin is a commit that exists in that repository's history: a SHA that only ever lived on a rebased or deleted branch cannot be checked and fails.

[`scripts/check-fixtures.sh`](../scripts/check-fixtures.sh) holds each vendored directory to its pin. It needs only bash, git and network access, and takes `--fixtures <dir>` (a port's fixtures directory, and the `lexicon/` inside it) or `--lexicon <dir>` (this repository's `test/lexicon`):

- It **fails** if a pinned commit does not exist (or an abbreviated SHA is ambiguous), or if any file differs from the pinned commit's by a single byte, is missing from the copy, or is in the copy but not at the pinned commit. Every file counts, at any depth and of any type, except `SOURCE` itself (and the `lexicon/` directory inside a port's fixtures directory, which is checked against its own pin).
- It **warns**, with a GitHub `::warning::` annotation and a zero exit status, if the pin is behind: the fixtures differ from the default branch of `atgeo-sdk-js`, a port's lexicons differ from that branch's `test/lexicon/`, or this repository's `test/lexicon/` differs from the default branch of garganorn. A warning is not a failure because a fixture change here would otherwise turn every port's CI red until each had re-vendored. Re-vendor at your leisure, but do: a port on a stale pin passes against a contract the reference no longer has.

Every port's CI runs it, from a copy of the script pinned by commit in the workflow so that a change to the script reaches a port only when that port moves the pin; this repository's CI runs it on `test/lexicon`. To re-pin, copy the files from the new commit, put its full SHA in `SOURCE`, and run the script before pushing.

It also reproduces the worked examples in sections 3 and 6, and ports the behavioural tests in `test/`. The tests that matter most, because they pin behaviour this document could describe wrongly:

- `region.test.ts`: serialization, outward snapping, degenerate spans, circle to bbox, antimeridian splitting, invalid regions.
- `merge.test.ts` and `distance.test.ts`: dedupe, ordering ties, region filtering for both region kinds, seams at ±180 and the poles, determinism.
- `client.test.ts`: getPlace cache and network paths, describe calls, result shapes, the required dataset, attribution and hit collections.
- `attribution.test.ts`: the attribution scenarios fixture, and the same scenarios with tiles arriving in reverse URL order.
- `wire.test.ts` and `robustness.test.ts`: the lenient readers against that fixture, and what a search, `getPlace` and the describe calls do with a malformed body (section 1).
- `transport.test.ts`: failed tiles (each `kind`, with its URL and status, in URL order), typed errors, URL construction.
- `cache.test.ts`: warm regions, expiry, the `getPlace` cache scan, and the attribution a warm search and a cached `getPlace` return. It has no test of LRU eviction or the cache budget; section 10 is the specification for those.
- `overview.test.ts`: the overview flag.
- `matchTiers.test.ts` and `accessors.test.ts`: the match tier fixture, and `name` and `location` on hits and places (sections 7 to 9).
- `frozenPlace.test.ts`: what an app can and can't change in a place or an attribution list it was handed (sections 8 and 9).
- `privacy.test.ts`: section 12, items 1 to 4.
- `keyword.test.ts`: `searchByKeyword`'s request, hits, attribution and argument checks (section 16), and section 12's item 6.
- `keywordRegions.test.ts` and `keywordFallback.test.ts`: the two keyword fixtures above, and with them section 12's items 6 and 7 (the captured `bbox`, the keyword's presence on the wire).
- `autocomplete.test.ts`: the qualifying predicate's skips and the autocompleter's supersession (sections 17 and 19), and section 12's item 8.
- `disclosed.test.ts`: `disclosed` on each result (section 4.11), and section 12's item 9.

The fake server should validate every request and response it handles against the lexicons where a lexicon validator exists for the language. Where none does, it must at least check the request parameter names, that `bbox` matches `^-?\d+\.\d\d,-?\d+\.\d\d,-?\d+\.\d\d,-?\d+\.\d\d$` for getTiles, and that its own responses carry the required fields. For `searchPlaces` the minimum is the parameter names (`dataset`, `collection`, `q`, `bbox`), that `dataset` and `q` are present, and that a `bbox` matches the whole-degree form `^-?\d+,-?\d+,-?\d+,-?\d+$`. It should also answer `InvalidBbox` for a box the server's rules refuse (section 16) and `KeywordRequired` by the server's own rule, not section 17's predicate (the server takes the keyword's words, drops duplicates, keeps the first 12 and refuses unless one is two or more characters long), so that the keyword fixtures check the port against the server's rules rather than against its own arithmetic. It must capture every request's URL for the privacy tests, and the method, headers and body where the port's transport seam carries them (a seam that carries only a URL fixes those by construction), and must be able to go offline (every request fails) and to fail named tiles.

## 14. Deliberate freedoms

A port may:

- decode JSON numbers more strictly than `parseFloat` (section 5);
- measure cache size in bytes (section 10);
- prune expired TTL entries;
- cancel sibling requests when a `getTiles` call fails, where structured concurrency does that for free;
- coalesce concurrent identical requests, as long as results are unchanged;
- throw a cancellation error from a fully cached call (section 11);
- fail a cancelled search with its cancellation error rather than with the error of the tile that was in flight (section 4.4);
- time out a request in its transport: a timeout is a network failure, and inside a tile fetch a failed tile. The reference gives every request 30 seconds in all, covering the body (`requestTimeoutMs`), and raises a `TimeoutError` `DOMException`; the Kotlin port and Rust's reqwest transport time out a connection after 10 seconds and a stalled read after 30, Rust's ureq transport adds 120 seconds for the whole call, and the Python port's `Urllib3Transport` 120 seconds (`total_timeout`) plus up to one read timeout (the Python port's aiohttp transport has no total), and the Swift port keeps `URLSession`'s default 60-second request timeout, which restarts whenever data arrives. A caller's cancellation is never reported as a timeout: it surfaces as the cancellation error (section 11), and a timeout while the caller's signal is still live is the network failure.
- cap the size of a response body in its transport, decoded size included: a larger body is a network failure, and inside a tile fetch a failed tile. Tile URLs come from the server and a small gzip body can decode to gigabytes. Every port's default transport caps at 32 MiB (the reference, Kotlin, Rust and Swift as `maxBodyBytes` / `max_body_bytes` / `defaultMaxBodyBytes`, Python as `DEFAULT_MAX_BODY_BYTES`); the largest tiles places.atgeo.org serves are about 2 MB. The reference reads the body as a stream and cancels it once the cap is passed. A response with no body stream is read whole and then checked.
- log each failed tile through the platform's standard logging facility, with no new dependency, at its debug level and never above, carrying only the fields of the tile's `tileFailures` entry, and only for a search that returns a result. The result is the contract's channel for failures; a log is a convenience for a developer who turns it on, and a library that logged a failed tile at a higher level would flood an app that searches on every keystroke over a poor connection.
- read a lone surrogate escape (`"\uD800"`) in a body as U+FFFD when its string type cannot hold a lone surrogate (Rust, Swift), saying so in its `CONFORMANCE.md`; such a port does not run `fixtures/match-tiers-lone-surrogates.json` (section 7).

A port must not:

- be stricter than section 1 about what a response may contain: fail a call over an unknown field, a missing optional field, a wrong-typed field it can treat as absent, or a record it can skip;
- retry a failed tile within a search;
- log above its platform's debug level, or log the search text or the region at any level (section 12);
- report a failure anywhere but to the app: no telemetry, no error report to the server (section 12);
- count as a failed tile an error from the client's own work after a tile is decoded (section 4.4);
- subdivide a region after `BboxTooLarge`;
- send the collection parameter for a dataset-only search;
- send anything but the snapped box, dataset and collection on a `searchNearby`, or the search text in any request it makes (a keyword method's request is section 16's);
- persist tiles, tile lists or the service description to disk by default;
- reorder results by anything not in section 8.

## 15. Out of scope for a first port

Carried over from the reference as-is, and open for all the SDKs together rather than one port:

- A disk cache. The HTTP layer is the seam: an app can supply one that caches, at the cost of the no-persistence default.
- A lower default cache budget on phones. 50 MiB stays, per the maintainer's decision; a port exposes the option and keeps the default. Measured on the Kotlin port, a parsed tile takes 6.9 times its body size on HotSpot and 5.1 times on ART, so a port that caches parsed tiles against a body-size budget holds 250 to 350 MB when full; the Kotlin port caches bodies instead and keeps only the latest search's tiles parsed (section 10), which makes the budget close to its heap cost. The Swift port, measured with its `atgeo-bench`, held 3.7 to 4.3 times the budget the same way (181 to 210 MiB full, on Linux, macOS 14 and macOS 26); caching bodies as the Kotlin port does, the bodies and an index of record-key hashes take 1.0 to 1.4 times, and 1.4 to 2.1 times with the latest search's tiles parsed (Swift PR #10). The JavaScript port has not been measured.
- Coalescing of duplicate in-flight requests.
- Restricting tile URLs. The server names the tile URLs and the client fetches them as given, so a compromised server can send a client anywhere. Section 12 covers what the client sends, not where. A port may want to refuse tile URLs that are not `https`, or that are off the server's host; none of the SDKs does yet, and it is a decision for all of them together.

## 16. searchByKeyword

`searchByKeyword(dataset, keyword, collection?, region?)` asks the server to match places by name, so it sends the keyword (section 12, items 6 and 9). `region`, when given, is a bbox only: a circle is refused, because a circle API invites the device's own position as its centre.

1. Validate, before any request, in the order of section 3. A keyword that cannot qualify (section 17) is not an argument error: it goes to the server, which answers `KeywordRequired` (an `AtgeoError`).
2. Snap the region outward to whole degrees (below). It always goes as one request, never split at the antimeridian.
3. `GET org.atgeo.searchPlaces` with `dataset`, `collection` only if given, `q` equal to the keyword exactly as passed (no trimming, no normalizing), and `bbox` only if a region was given. A keyword over 256 bytes of UTF-8 is not checked client-side; the server answers `InvalidRequest`.
4. Read the body as section 1 says (the port's decoding error without a `places` array). Each kept element becomes a hit, in the server's order, with no dedupe (the server returns each place once), no region filter and no ranking, with these fields (table below the list):
5. `attribution` is the union of every kept element's `attribution`, walking the elements in served order and each element's entries in served order, keeping the first entry for each `(dataset, collection)` pair, then sorted as in 4.10. Always a list.
6. `disclosed = { keyword: true, region: 1 }` if a region was given, `{ keyword: true, region: null }` if not.

| Field | Value |
|---|---|
| `via` | `"keyword"` |
| `origin`, `place`, `importance`, `name`, `location` | as for a hit (section 8), from the element's reader result |
| `collection` | as section 8, matched against the element's own `attribution` list rather than a tile's |

A keyword hit has no `distance` and no `score`: the server ranks by neither, and an app can compute a distance from `location`.

The call is not cached (section 10). The result is `{ places, attribution, disclosed }`.

### Whole-degree snapping

The result is the smallest box the server accepts that covers the input. The server's rules: every coordinate is a whole number written with no fractional digits and no exponent (a port writes plain integers, and negative zero as `0`); `south < north`; and either `west < east`, or the box crosses the antimeridian, with `west > 0 > east` and a width under 360 degrees. Input values are those the caller gave, validated as in section 3 (a bbox with `west > east` is valid whatever the signs).

```
span(lo, hi, limit):
  lo = floor(lo); hi = ceil(hi)
  if lo == hi: if hi < limit then hi += 1 else lo -= 1
  return (lo, hi)
```

- Latitude: `(south, north) = span(minLat, maxLat, 90)`.
- Longitude, first the two seams, decided on the input values: if `west > east` and `west` is exactly 180, set `west = -180`; then, if `west > east` and `east` is exactly -180, set `east = 180`. A west of 180 means the meridian at -180, and an east of -180 means 180, so those boxes continue below as plain boxes. Both at once, `[180, …, -180, …]`, becomes `[-180, -180]`, which `span` widens to `[-180, -179]`.
- Longitude, now not crossing (`west <= east`): `(west, east) = span(west, east, 180)`.
- Longitude, still crossing (`west > east`): `w = floor(west)`, `e = ceil(east)`. If `w > 0` and `e < 0`, send `w` and `e` (after the seam rules above the width is always under 360 degrees). Otherwise (the snapped edges meet or pass each other, or the signs don't fit the server's rule: `[0.5, …, -0.5, …]`, `[179.5, …, -0.5, …]`, `[170.5, …, 160.5, …]`) send the full band, `-180` and `180`, which covers any crossing box.

The `bbox` string is `west,south,east,north` as integers joined by commas: `-123,37,-122,38`. `fixtures/keyword-regions.json` lists every seam; a port writes the steps as given and runs the fixture rather than reasoning about the corners.

The server checks the whole-degree rule as a rule about the string (`-76.0` and `1e1` are refused as `BboxTooPrecise`; `76.` is accepted), and the crossing rule as `InvalidBbox`. A port that sends plain integers meets both.

## 17. The qualifying keyword

The server refuses a keyword with `KeywordRequired` unless, among its first 12 distinct words after case, accents and punctuation are removed, one is at least two characters long. `searchNearbyThenByKeyword` and the autocompleter skip the request for a keyword the server would refuse, because there an unqualified string is ordinary input. A port implements the predicate internally (no API) with exactly these steps:

1. `normalize(keyword)` (section 7), then split on U+0020. An empty keyword has no words.
2. Fold each word (section 7's `fold`: remove U+0027, U+2019 and U+02BC; replace each run of punctuation with a space; split; drop empty strings), and concatenate the results.
3. From each word remove every scalar whose general category is Mc (spacing mark) or Me (enclosing mark); drop the words left empty; recompose each remaining word with NFC.
4. Remove duplicate words, keeping the first of each; take the first 12.
5. The keyword qualifies if any of these has two or more code points (Unicode scalars, not UTF-16 units).

This is not match tier 1's tokenization (section 7), which takes 12 words before folding and does not deduplicate; a port must not reuse that code. Step 3's NFC and Mc/Me removal match the server's own behaviour: `normalize` applies NFKD, which splits a precomposed Hangul syllable such as `하` into two jamo, while the server keeps it whole; and `normalize` strips only nonspacing marks, where the server strips all three kinds, so a consonant with a spacing vowel sign (`का`) is one character to the server. Without those steps the SDK would send, and the server refuse, keywords like those.

The predicate can still disagree with the server on compatibility characters that NFKD expands (`ﬁ`, `½`) and on half-width kana, and on the whitespace set at U+000B and U+FEFF. A disagreement shows up either as a request the server refuses with `KeywordRequired`, which the fallback and the autocompleter treat as no answer (sections 18 and 19), or as a skipped request the server would have answered, which is the harmless direction. An exhaustive comparison found about 3,500 compatibility-class inputs where the SDK sends and the server refuses (#56).

## 18. searchNearbyThenByKeyword

`searchNearbyThenByKeyword(region, dataset, keyword, keywordRegion, collection?, sort?)` runs a `searchNearby` with `text = keyword` and, only if that finds nothing solid, a keyword request.

1. Validate, in the order of section 3. `keywordRegion` is `"none"` or `"degree"` and has no default: the caller decides whether a region goes with the keyword.
2. Run `searchNearby` with `text = keyword` and the call's other options.
3. Solid hit: if some hit of the nearby result has match tier 1 (section 7), return the nearby result as it is, with its own `disclosed`. No keyword request is made.
4. If the keyword cannot qualify (section 17), return the nearby result likewise: the request would certainly fail with `KeywordRequired`.
5. Otherwise call `searchByKeyword` (section 16) with the call's `dataset`, `collection` if any, the cancellation signal and `keyword` and, for `"degree"`, a region that is the nearby region as a box: a bbox region as given, a circle as its enclosing box (section 3), snapped as in section 16. For `"none"`, no region.
6. Merge: the keyword hits in the server's order, then the nearby hits in nearby order, leaving out any nearby hit whose `origin` equals a keyword hit's. A hit with a null `origin` is never left out. Keyword hits lead because they match the tier-1 rule, and every nearby hit here is tier 2; tier 1 precedes tier 2 everywhere.
7. The result is the nearby result with `places` replaced by the merged list (each hit keeping its `via`), `attribution` the union of the nearby and keyword attribution (deduplicated and sorted as in 4.10, the nearby entry winning a tie), and `disclosed = { keyword: true, region }` where `region` is the finest region sent during the call: `0.01` if the nearby search sent anything, else `1` for `"degree"`, else null. A cold `"degree"` fallback therefore reports `0.01` though the keyword travelled with a one-degree box. `complete`, `overview`, `tiles` and `tileFailures` are the nearby search's.
8. A keyword request the server refuses with `KeywordRequired` (section 17's predicate let it through) does not fail the call: the result is the nearby result, as in step 4, except that `disclosed = { keyword: true, region }` with `region` as in step 7, since the keyword went out. Any other failed keyword request rejects the call, as a failed `getTiles` does, with the keyword request's own error, and the nearby results are lost. A cancelled keyword request does the same with the cancellation outcome. There is no result, so no `disclosed`, though the keyword may have gone out: a port's documentation says that a failure after the nearby half means the keyword may have reached the server. No port attaches `disclosed` to the error, so that the ports' error types stay alike (#58).

A nearby search that had failed tiles (`complete = false`) and no tier-1 hit still falls back, though the missing tiles might have held one. The solid-hit test runs on the hits that cleared the 0.6 similarity threshold, so a short keyword whose only tier-1 place scored under 0.6 falls back. `fixtures/keyword-fallback.json` pins the decision and the merge.

## 19. autocompleteByKeyword

`autocompleteByKeyword(dataset, collection?, region?)` returns an autocompleter, an object with one operation, `searchByKeyword(keyword, cancellation?)`. Each text field makes its own: "the previous call" belongs to the autocompleter, so two fields on one page, sharing a client, do not supersede each other. Beyond its options it holds only the previous call's cancellation handle, and caches nothing.

`dataset` and `region` are validated, as section 16, when the autocompleter is made. `searchByKeyword(keyword)` does this, in order:

1. Supersede the previous call, if any, so that it ends with the port's superseded outcome (below).
2. A `keyword` that is not a string is the argument error (this happens after step 1).
3. If the keyword cannot qualify (section 17), resolve `{ places: [], attribution: [], disclosed: { keyword: false, region: null } }` with no request.
4. Otherwise run `searchByKeyword` (section 16) with the autocompleter's `dataset`, `collection` and `region` and this keyword, under a cancellation that is both this call's own (so a later call can supersede it) and the caller's (section 11). If the server refuses the keyword with `KeywordRequired`, resolve `{ places: [], attribution: [], disclosed: { keyword: true, region } }`, `region` being `1` if the autocompleter has a region and null if not: the keyword went out, but there is nothing to show. Any other failure rejects as `searchByKeyword` would.

Every string that qualifies goes to the server as typed, prefixes included. A port's documentation says so, neutrally: the server keeps no log of it (garganorn's privacy design), a hostile operator can record what it receives, and debouncing reduces how many prefixes go out and is the app's choice. A port does not debounce, and does not offer to.

The superseded outcome, which an app must treat as "ignore this answer", is the port's cancellation error where the port can cancel a call in flight, and a port-specific one where it cannot:

| Port | Superseded call |
|---|---|
| JS | rejects with an `AbortError` `DOMException` |
| Swift | `CancellationError`; each call runs in a `Task` the autocompleter cancels, and the caller's own cancellation is honoured through `withTaskCancellationHandler` |
| Kotlin | `CancellationException`; each call is a `Job` the autocompleter cancels, run as a child of the caller's coroutine |
| Python async | `asyncio.CancelledError`; each call runs as an `asyncio.Task` the autocompleter cancels |
| Rust async | `Error::Superseded`: dropping a future cancels it, and the autocompleter does not own the caller's future, so it cannot cancel it and returns an error instead |
| Rust and Python blocking | no autocompleter: a blocking client cannot cancel a call in flight, and autocomplete is a UI behaviour for the async clients |

A superseded call's cancellation reaches a caller that was not itself cancelled (Swift's `Task.isCancelled` and Python's `task.cancelling()` are false for it), so a port's spec says that a cancellation error from an autocompleter's call means "superseded" and is to be ignored. A caller that does cancel its own call gets the cancellation outcome of section 11, with the reason it gave where the platform carries one.
