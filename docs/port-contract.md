# Port contract

What a port of `@atgeo/client` to another language must do to be the same client. The Swift and Kotlin specs ([swift-sdk-spec.md](swift-sdk-spec.md), [kotlin-sdk-spec.md](kotlin-sdk-spec.md)) describe each port's API, packaging and idioms, and point here for behaviour, so that the three SDKs can't drift apart on what a search returns.

The reference is the TypeScript source in `src/` at the commit this document was written against (`8654ea7`). Where this document and the source disagree, the source wins and this document has a bug, except for the reference deviations listed in [section 16](#16-known-reference-deviations), where the behaviour stated here is the contract. The fixtures in `fixtures/` and the lexicons in `test/lexicon/` are the executable half of this contract; see [Conformance](#conformance).

"Must" marks behaviour a port has to reproduce. "Should" marks the reference behaviour where a port may do better, as long as the observable results stay the same. "May" marks a deliberate freedom.

The client is tolerant by design. It reads only the fields it needs, ignores everything else, treats a missing or wrong-typed value as absent, and never fails a search because of one record or one tile. It fails only when it cannot do the job at all: a `getTiles` call that errors or yields no usable tile list, or a `getPlace` or describe call that errors or has no usable body. Where this document says a value "is" some type, that is what a compliant server sends; the rule next to it says what a port does when it isn't. A port must not be stricter than this document about what a response may contain, so that a server change that keeps the wire functional does not break the apps built on a port.

## 1. Wire protocol

Everything goes over HTTP GET with no request body. There are four XRPC queries and plain tile fetches.

| Call | URL | Parameters |
|---|---|---|
| getTiles | `{server}/xrpc/org.atgeo.getTiles` | `dataset`, `bbox`, and `collection` only when the search has one |
| getPlace | `{server}/xrpc/org.atgeo.getPlace` | `uri` |
| describeService | `{server}/xrpc/org.atgeo.describeService` | none |
| describeTileset | `{server}/xrpc/org.atgeo.describeTileset` | `slug` |
| tile | the URL from `getTiles.tiles`, byte for byte | none |

`{server}` is the configured server with trailing slashes removed. The default is `https://places.atgeo.org`.

Query values must be percent-encoded so the server decodes them to the exact strings. The reference uses form encoding (`URLSearchParams`), which turns `,` into `%2C` and `:` into `%3A`; a port may send those two characters raw. Space, `&`, `=`, `#`, `+` and `%` must be encoded. The reference form-encodes a space as `+`; `%20` is equally acceptable. A literal `+` must go as `%2B`, since a form-decoding server reads a raw `+` as a space.

Responses are JSON. The schemas are the lexicons in `test/lexicon/`; the ones a port reads are:

- `getTiles` → `{ tiles: string[], overview?: boolean }`. `tiles` is in ascending string order on the wire, but the client sorts anyway (section 4). Entries that are not strings are skipped (section 16). `overview` follows JavaScript truthiness, which is exactly: false when absent, `null`, `false`, `0`, `-0` or `""`, and true for any other value. A body with no `tiles` array has no usable tile list (Errors, below).
- tile payload (`org.atgeo.tilePayload`) → `{ records: [{ value, uri?, importance? }], ... }`. Only `value`, `uri` and `importance` are kept per record; `publishedAt` and `attribution` are ignored. A record that is not an object, or whose `value` is not an object, is skipped and the tile is still used. A `uri` that is not a string, and an `importance` that is not a number, are absent (section 16).
- `getPlace` → `{ uri, record, importance? }`. `record` must be an object, or the response has no usable body; `importance` as for a tile record; `uri` is not read. The reference checks none of this (section 16).
- `describeService` → `{ did, tilesets: [{ slug, collections: [{ dataset, collection }] }] }`.
- `describeTileset` → `org.atgeo.defs#tileset`.

For the two describe calls, every field is optional on the way in. A port's typed representation treats a missing field, or one of the wrong type, as absent; a list the lexicon requires (`tilesets`, and `collections` inside a tileset) that is missing or not an array as empty, and an optional list as absent; an array element that cannot be read as dropped; and unknown fields as ignored. The lexicons say what a compliant server sends; the client must not fail because the server sends more, less, or a different type in a field the app may not even read.

`value` (a tile record) and `record` (getPlace) are `org.atgeo.place` values and must be surfaced to the caller unmodified: every key, nested value and unknown field as served. Nothing about the schema of a place is assumed beyond what sections 5 and 7 read.

`importance` is a JSON integer on the wire, decoded through a double and range-checked into a signed 64-bit integer, so precision beyond 2^53 is lost exactly as in the reference; a port must not decode the literal exactly, or it would order huge values differently from the other SDKs. A compliant server never sends a non-integer; when one arrives, the reference keeps it as a float and a port whose importance type is integral truncates it toward zero. A number whose magnitude is 2^63 or more is absent (the check is symmetric, so exactly -2^63 is absent too, although a signed 64-bit integer could hold it). Anything that is not a JSON number, including an array or a string holding one, is absent (section 16). None of this fails the tile.

### Errors

A non-2xx response raises the port's `AtgeoError` type with a `code` string and a `message`. If the body is a JSON object whose `error` is a string, that is the code; otherwise the code is `HttpError`. If its `message` is a string, that is the message; otherwise the message is `HTTP {status}`. Each field is judged on its own, and a body that is not a JSON object has neither (section 16). The body is read before the status is checked, so a server that sends an error body with a non-2xx status is always reported with its own code.

Every code other than `HttpError` comes from the server. The lexicons declare which codes each query can return: `BboxTooLarge`, `BboxTooPrecise`, `DatasetNotFound`, `CollectionNotFound`, `InvalidBbox` for getTiles; `PlaceNotFound` for getPlace; `TilesetNotFound` for describeTileset; `InvalidRequest` for any malformed parameter. The list is informative, not closed: a port passes any code through unchanged and never decides what to do by matching on it, so that a code the server adds later is reported, not mishandled.

A 2xx response whose body is not valid JSON, or decodes but has no usable body, raises the port's JSON decoding error, not `AtgeoError`, except inside a tile fetch (section 4), where it counts as a failed tile. "No usable body" is the narrow list above: a `getTiles` body with no `tiles` array, a `getPlace` body with no `record` object, a describe body that is not an object. Nothing else about a body's shape is an error. The reference checks none of this (section 16).

Network failures propagate as the port's HTTP layer's own error type, unwrapped. The transport follows at least same-scheme redirects (the JVM's `HttpURLConnection` does not cross from `http` to `https`), and the response's content type is not checked.

## 2. Client construction

Options, all optional:

| Option | Default | Meaning |
|---|---|---|
| `server` | `https://places.atgeo.org` | Base URL for XRPC calls. Trailing slashes are stripped. |
| HTTP implementation | the platform's | Injected for tests, proxies and custom networking. It must be able to fetch arbitrary absolute URLs, since tile URLs come from the server. |
| `cacheBudgetBytes` | 50 MiB (52,428,800) | Cap on the in-memory tile cache (section 10). |

A client holds three caches (tile lists, tiles, service description) that start empty. There is no persistence. Two clients share nothing.

## 3. Regions

A region is a circle `{ lat, lon, radius }` (radius in metres) or a bounding box `[minLon, minLat, maxLon, maxLat]` in degrees.

### Validation

`searchPlaces` must reject, before any network activity and with the port's argument-error type (not `AtgeoError`), checking in this order so that the error for a call with two faults is the same everywhere:

- a bbox where any longitude is non-finite or `|lon| > 180`, any latitude is non-finite or `|lat| > 90`, or `minLat > maxLat`;
- a circle where `lat` or `lon` fails the same checks, or `radius` is non-finite or negative;
- `sort = similarity` when the normalized text (section 7) is empty.

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

`searchPlaces(region, text?, dataset?, collection?, sort?)` runs these steps in order.

### 4.1 Resolve dataset and collection

| `dataset` | `collection` | searched |
|---|---|---|
| absent | absent | `overturemaps.org` / `place` |
| absent | given | `overturemaps.org` / that collection |
| given | absent | the whole dataset, no collection filter |
| given | given | that collection |

The `collection` query parameter is sent only when the search has a collection.

### 4.2 Tile lists

For each bbox string from section 3, in order, look up the tile-list cache under the key `"{dataset}|{collection or empty}|{bbox}"`. On a miss, call `getTiles` and cache `{ tiles: the string entries of response.tiles, overview: truthy(response.overview) }` (section 1) for one hour (section 10). The calls for the two halves of a crossing region run concurrently.

If any `getTiles` call fails (server error, network, or no usable tile list), the whole search fails with that error, and nothing is cached for that key. The search does not subdivide after `BboxTooLarge`.

`overview` for the search is true if any half's list is overview.

### 4.3 Tile URLs

Take the union of every list's `tiles`, remove duplicates, and sort ascending by UTF-16 code unit comparison (plain ordinal string order; `"https://A" < "https://a" < "https://a/10" < "https://a/9" < "https://b"`). This order fixes the dedupe winner (4.6), so it must not depend on completion order or on which half of a crossing region named the tile.

### 4.4 Fetch tiles

For each URL in that order, with at most 8 fetches in flight:

- A tile in the tile cache is used without a request, and is marked recently used.
- Otherwise fetch the URL exactly as given. On a 2xx with a body that decodes to a payload with a `records` array, keep `{ value, uri?, importance? }` per usable record (section 1: a record that is not an object, or has no object `value`, is skipped, and skipping never fails the tile), store the tile in the cache with its size (section 10), and use it. A tile whose every record was skipped is still a used tile with no records.
- Any other outcome (non-2xx, network error, undecodable body, a payload that is not an object, `records` absent or not an array) marks the tile failed. It is skipped, not retried, and the search continues.
- If the search was cancelled, a tile failure is not swallowed. The reference rethrows the tile's own error, so a search aborted while a tile with an unparsable body was in flight fails with the JSON error, not the cancellation error; a port may fail with its cancellation error instead (section 14).

The result's `tiles.fetched` is the number of tiles used, from cache or network. `tiles.failed` is the number that failed. `complete` is `failed == 0`.

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

Section 8. The result is `{ places, complete, overview, tiles: { fetched, failed } }`.

Warm searches: a repeat of the same region within the hour, with every tile still cached, makes no request at all. Changing only `text` or `sort` reuses everything.

## 5. Reading a place's location

`locate(value)` returns `{ point?, bbox? }` from `value.locations`, which must be an array for anything to be found:

- `point` is the first element with `$type == "community.lexicon.location.geo"` whose `latitude` and `longitude` parse to finite numbers.
- `bbox` is the first element with `$type == "community.lexicon.location.bbox"` whose `south`, `north`, `east`, `west` all parse to finite numbers; it is stored as `{ south, north, segments: lonSegments(west, east) }`, so a box with `west > east` crosses the antimeridian.

Both may be present. Elements with other `$type`s, and elements whose numbers don't parse, are skipped (a non-parsing geo element does not stop a later geo element from being the point). An element that is not a JSON object is skipped too (section 16 for `null`). Coordinates are not range-checked: a latitude of 95 or a longitude of 200 is kept as parsed and the geometry of section 6 is applied to it as is.

Parsing: the lexicon types these as strings; the reference converts whatever is there to a string and applies JavaScript `parseFloat`, so a JSON number works too. A port must accept a JSON string holding a decimal number (optional sign, optional fraction, optional exponent) and a JSON number. It may reject what `parseFloat` would partially accept (leading whitespace, trailing garbage such as `"1.5abc"`), and a port's own number parser may accept forms `parseFloat` does not (hex floats, a trailing `f`). These margins are a known, documented divergence between the SDKs rather than something to make exact, because garganorn emits none of them; a port lists the forms its parser treats differently in its `CONFORMANCE.md`. `Infinity`, `NaN` and the like are non-finite and are skipped.

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
3. Remove every scalar whose general category is Mn (nonspacing mark). This strips the accents NFKD split off: `café` → `cafe`, and the dot from `İ`, giving `istanbul`. Mc and Me marks stay (`a` + U+20DD is unchanged).
4. Replace every run of one or more whitespace scalars with a single U+0020, then strip leading and trailing whitespace. The whitespace set is exactly JavaScript's `\s`: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. U+200B (zero-width space) and U+0085 are not in it. Ideographic space counts, so `　東京　` → `東京`.

`fixtures/normalize.json` must pass exactly. Runtimes disagree on Unicode versions at the margins; the fixture is the arbiter. It does not yet cover the final sigma, `İ` and `ẞ` cases above, so until it does a port tests those three itself; the Swift spec names the runtime that is expected to differ.

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

Words past the twelfth count only in the whole-query comparison. `variants` must be an array for its names to count; a variant that is not an object (section 16 for `null`), or whose `name` is not a string, is skipped.

A record whose score is below `0.6` is dropped (exactly 0.6 is kept). Without text, the score is null and nothing is dropped.

Examples with the reference: for query `Starbux`, `Starbucks` scores `0.9048`, `Star Bakery` `0.8740`, `Stardust Bar` `0.8530`, and `Home Depot` is dropped. For `Munich`, a place named `München` with variant `Munich` scores `1`.

## 8. Ranking

For each surviving record build a hit:

| Field | Value |
|---|---|
| `origin` | the record key (section 4.6), or null |
| `place` | `value`, untouched |
| `importance` | the record's `importance`, or null |
| `distance` | `distanceTo(locate(value), centre)` in metres; never null here, since the region filter already required a location |
| `score` | `textScore`, or null without text |

Internally each hit also carries `specificity`: 0 for a hit with a point or no bbox, else the box's relative spherical area `(sin north - sin south) · Σ(hi - lo)` over its segments, in radians. It is not part of the result.

Comparators, each returning negative when `a` sorts first:

- `byScore`: `round3(b.score ?? 0) - round3(a.score ?? 0)`, with `round3(x) = round(x * 1000) / 1000`, round half away from zero (scores are non-negative). Best first; scores that differ only past the third decimal tie.
- `byImportance`: `(b.importance ?? 0) - (a.importance ?? 0)`. Larger first. A null importance sorts as 0: above negatives, tied with 0.
- `byDistance`: `a.distance - b.distance`. Nearest first.
- `bySpecificity`: `a.specificity - b.specificity`. Smaller first.
- `byOrigin`: equal origins tie; a null origin sorts after any string; otherwise ordinal string comparison.

Sort modes:

| Mode | Order |
|---|---|
| `fused` (default) | score, importance, distance, origin |
| `distance` | distance, specificity, importance, score, origin |
| `similarity` | score, distance, origin |

The sort must be stable: hits that tie on every comparator (only possible when both lack an origin, since dedupe leaves one hit per origin) keep their order from section 4.5. A port that cannot rely on its library sort being stable must add the input index as a final tie-break.

`fixtures/ranking-scenarios.json` must pass: for each scenario, run the records through sections 4.6 to 4.9 (no network) and check that each `expect.top[k].origins` set is a subset of the first `k` hits' origins and each `expect.absent` origin is not in the result at all. The fixture checks membership, not order.

## 9. The other calls

`getPlace(origin)`: search the tile cache for a record whose key (4.6) equals `origin`; if several cached tiles hold one, take the record from the lowest tile URL. The scan does not mark any tile recently used (section 10). On a hit return `{ origin, place: value, importance ?? null }` with no request. On a miss call `getPlace` with `uri = origin` (no `describeService` first) and return `{ origin, place: record, importance ?? null }`. The returned `origin` is the caller's string, not the response's `uri`.

`describeService()`: cached for one hour; otherwise one request. Returned as decoded, leniently (section 1).

`describeTileset(slug)`: never cached; one request per call. Returned as decoded, leniently (section 1).

## 10. Caching

Three caches, all in memory, none persisted, none shared between clients.

- Tile lists: key from 4.2, value `{ tiles, overview }`, expires 3,600,000 ms after being set, by wall-clock time: an entry is fresh while `now < set + 3,600,000` and a miss from exactly that instant on. Entries need not be evicted on expiry, but a port may prune them.
- Service description: one entry, same one-hour expiry.
- Tiles: keyed by URL, LRU, capped by `cacheBudgetBytes`. A tile's size is the length of its response body; the reference counts UTF-16 code units of the text, a port counts bytes. Reading a tile by URL during a search marks it most recently used; the `getPlace` scan (section 9) does not. Inserting a tile adds its size and then evicts least recently used tiles until the total is within budget (a single tile larger than the budget evicts every other tile and then itself, so the cache never exceeds the budget after an insert). Replacing a URL subtracts the old size first.

Expiry tests set the clock, so a port must take its time source from somewhere a test can control.

## 11. Cancellation

Every network-touching call accepts the platform's cancellation mechanism. Cancellation surfaces as the platform's cancellation error, from whatever request was in flight. In the reference, a call answered entirely from cache completes normally even when already cancelled; a port should match this, but it is not a conformance requirement.

## 12. Privacy invariants

These are what the client is for, and must be covered by tests against a request-capturing fake server:

1. The search text never appears on the wire: not raw, not normalized, not any of its words, not URL-encoded, not in a header, not in a body, in any case folding. Test with text such as `Zanzibar Quokka`, `  ZANZIBÁR   quokka `, and check every request's URL (raw and percent-decoded), headers and body for the text, its trimmed and lowercased forms, the normalized form, each normalized word, and prefixes such as `zanzib`.
2. A search issues only `getTiles` and tile requests, all GET, with no body.
3. Precise coordinates never appear on the wire. For a circle at `37.7749295, -122.4194155` with radius `123.456789`, none of `37.7749295`, `122.4194155`, `7749295`, `4194155`, `123.456789` appears in any request. For a bbox of full-precision corners, none of the corner digit strings appears.
4. `getPlace` on a cache miss sends the origin and nothing else.

## 13. Conformance

A port vendors, at a pinned atgeo-sdk-js commit recorded in a `SOURCE` file:

- `fixtures/normalize.json` (30 cases, exact match),
- `fixtures/jaro-winkler.json` (33 cases, within 5e-7),
- `fixtures/ranking-scenarios.json` (12 scenarios, membership),
- `test/lexicon/*.json`, for a fake server that validates its own traffic.

It also reproduces the worked examples in sections 3 and 6, and ports the behavioural tests in `test/`. The tests that matter most, because they pin behaviour this document could describe wrongly:

- `region.test.ts`: serialization, outward snapping, degenerate spans, circle to bbox, antimeridian splitting, invalid regions.
- `merge.test.ts` and `distance.test.ts`: dedupe, ordering ties, region filtering for both region kinds, seams at ±180 and the poles, determinism.
- `client.test.ts`: getPlace cache and network paths, describe calls, result shapes, dataset and collection resolution.
- `transport.test.ts`: failed tiles, typed errors, URL construction.
- `cache.test.ts`: warm regions, expiry, LRU eviction.
- `overview.test.ts`: the overview flag.
- `privacy.test.ts`: section 12.

The fake server should validate every request and response it handles against the lexicons where a lexicon validator exists for the language. Where none does, it must at least check the request parameter names, that `bbox` matches `^-?\d+\.\d\d,-?\d+\.\d\d,-?\d+\.\d\d,-?\d+\.\d\d$`, and that its own responses carry the required fields. It must capture every request (URL, method, headers, body) for the privacy tests, and must be able to go offline (every request fails) and to fail named tiles.

## 14. Deliberate freedoms

A port may:

- decode JSON numbers more strictly than `parseFloat` (section 5);
- measure cache size in bytes (section 10);
- prune expired TTL entries;
- cancel sibling requests when a `getTiles` call fails, where structured concurrency does that for free;
- coalesce concurrent identical requests, as long as results are unchanged;
- throw a cancellation error from a fully cached call (section 11);
- fail a cancelled search with its cancellation error rather than with the error of the tile that was in flight (section 4.4);
- time out a request in its transport: a timeout is a network failure, and inside a tile fetch a failed tile. The reference relies on its platform's `fetch` defaults: in Node, undici's (10 seconds to connect, 300 seconds for headers and body); in a browser, whatever the browser imposes.

A port must not:

- be stricter than section 1 about what a response may contain: fail a call over an unknown field, a missing optional field, a wrong-typed field it can treat as absent, or a record it can skip;
- retry a failed tile within a search;
- subdivide a region after `BboxTooLarge`;
- send the collection parameter for a dataset-only search;
- send anything but the snapped box, dataset and collection on a search;
- persist tiles, tile lists or the service description to disk by default;
- reorder results by anything not in section 8.

## 15. Out of scope for a first port

Carried over from the reference as-is, and open for all three SDKs together rather than one port:

- A disk cache. The HTTP layer is the seam: an app can supply one that caches, at the cost of the no-persistence default.
- A lower default cache budget on phones. 50 MiB stays, per the maintainer's decision; a port exposes the option and keeps the default.
- Coalescing of duplicate in-flight requests.
- Restricting tile URLs. The server names the tile URLs and the client fetches them as given, so a compromised server can send a client anywhere. Section 12 covers what the client sends, not where. A port may want to refuse tile URLs that are not `https`, or that are off the server's host; none of the three SDKs does yet, and it is a decision for all of them together.

## 16. Known reference deviations

Reference behaviour at `8654ea7` that a port must not reproduce: crashes, wrong counts, and places where the reference is laxer about types than section 1. This section wins over the source. The crashes and wrong counts are to be fixed in the reference, after which this section shrinks.

- A `getTiles` body that decodes but has no `tiles` array (`{}`, `[]`, `{ "tiles": "x" }`) is reported as one failed tile and no places, because the undefined list is treated as a tile URL, and the bad list is cached for an hour. A `null` body throws a bare `TypeError`. Entries of `tiles` that are not strings are fetched as URLs and counted as failed tiles. A port raises its decoding error for a missing list and caches nothing, and skips non-string entries (sections 1 and 4.2).
- A `null` element in a place's `locations` throws a bare `TypeError` from the region filter and fails the whole search, for a record that reaches that filter; so does a `null` element in `variants` when the search has text. Other non-object elements are skipped harmlessly. A port skips `null` too (sections 5 and 7).
- A tile record that is a number, a string or an array, or whose `value` is `null` or missing, throws a bare `TypeError` from the dedupe step after the tile was counted as fetched. A `null` record fails its whole tile, since destructuring it throws inside the tile fetch. A `value` that is a scalar does not throw: it has no location and the region filter drops it, but it consumes its dedupe key first, so a later copy with the same `uri` is lost. The bad records are also cached with their tile, so every later search that touches the tile, and every `getPlace` call, throws the same `TypeError` until the tile is evicted. A port skips every such record and keeps the tile (section 4.4).
- A `uri` that is not a string is used as a dedupe key and surfaced as the hit's `origin` as is; an `importance` that is not a number is surfaced as is; a coordinate given as a one-element array (`latitude: [0.5]`) parses as that element, because the reference stringifies before parsing; `error` and `message` fields of an error body that are not strings are surfaced as is; and a non-2xx body of `null` throws a bare `TypeError`. A port treats each as absent (sections 1 and 5).
- A `getPlace` body with no object `record` is returned with `place` missing or non-object, and a `null` body throws a bare `TypeError`. A describe body of any JSON type is returned as is, and a falsy service description (`null`, `false`, `0`, `""`) is fetched again on every call. A port raises its decoding error for a body that is not an object, or a `getPlace` body with no object `record` (section 1).
