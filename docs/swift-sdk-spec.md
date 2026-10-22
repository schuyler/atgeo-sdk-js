# Swift SDK specification

A Swift port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the Swift package, its public API, and the decisions that are specific to Swift. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: proposal. Nothing here has been built. The normalization and similarity recipes in section 6 follow the contract but have not been run against the fixtures from Swift yet (the JVM recipes in the Kotlin spec have), and section 6 names one place (final sigma) where Swift's standard library is expected to differ. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Swift: `async`/`await`, structured cancellation, value types, `Sendable` throughout, usable from Swift 6 strict concurrency.
- No dependencies beyond Foundation. The package must build on Linux so that CI can run without a Mac and so that server-side Swift can use it.

Non-goals for the first release: persistence, offline packs, a SwiftUI layer, Objective-C interoperability.

## 2. Package

Repository: `schuyler/atgeo-sdk-swift` (assumed; rename at will). Package name `atgeo-sdk-swift`, one library product and module named `Atgeo`.

```
Package.swift
Sources/Atgeo/
  AtgeoClient.swift      the actor; search pipeline (contract §4)
  Region.swift           Region, validation, centre, circle box, snapping (§3)
  Locations.swift        locate, distanceTo, inRegion (§5, §6)
  Text.swift             normalize, jaroWinkler, textScore (§7)
  Rank.swift             hit construction and comparators (§8)
  Cache.swift            TileCache (LRU) and TtlCache (§10)
  Transport.swift        HTTPTransport, URLSessionTransport, XRPC URL building, AtgeoError (§1)
  JSONValue.swift        the JSON model for place values
  Types.swift            SearchResult, SearchHit, PlaceRecord, ServiceDescription, Tileset, …
Tests/AtgeoTests/
  Fixtures/              vendored from atgeo-sdk-js: fixtures/*.json, test/lexicon/*.json, SOURCE
  FakeServer.swift       request-capturing HTTPTransport (§13)
  *Tests.swift           one file per reference test file
```

Tools version 6.0 and language mode 6 (`swiftLanguageModes: [.v6]`), so that strict concurrency is checked from the first commit; retrofitting `Sendable` is harder than starting with it. Platforms: iOS 15, macOS 12, tvOS 15, watchOS 8, visionOS 1, and Linux. These are the floors for `URLSession.data(for:)` with `async`; the tools version does not raise them. Requiring a Swift 6 toolchain rules out Xcode 15, which is the price of Swift Testing and language mode 6 without a second build configuration.

Distribution during beta mirrors the JS client: unpublished to any registry, added as a SwiftPM dependency by GitHub URL pinned to a commit (`.package(url:revision:)`). Tag semantic versions once the wire contract settles.

## 3. Public API

Names follow the Swift API Design Guidelines, so one method differs from the other SDKs:

| JS / Kotlin | Swift |
|---|---|
| `searchPlaces(options)` | `searchPlaces(region:text:dataset:collection:sort:)` |
| `getPlace({ origin })` | `place(origin:)` |
| `describeService()` | `describeService()` |
| `describeTileset(slug)` | `describeTileset(_ slug:)` |

The XRPC-named methods keep their names because they are the names of the server queries they wrap, and that is how a reader will look them up.

```swift
public actor AtgeoClient {
    public static let defaultServer = URL(string: "https://places.atgeo.org")!
    public static let defaultCacheBudgetBytes = 50 * 1024 * 1024

    public init(
        server: URL = AtgeoClient.defaultServer,
        transport: any HTTPTransport = URLSessionTransport(),
        cacheBudgetBytes: Int = AtgeoClient.defaultCacheBudgetBytes
    )

    public func searchPlaces(
        region: Region,
        text: String? = nil,
        dataset: String? = nil,
        collection: String? = nil,
        sort: SortMode = .fused
    ) async throws -> SearchResult

    public func place(origin: String) async throws -> PlaceRecord
    public func describeService() async throws -> ServiceDescription
    public func describeTileset(_ slug: String) async throws -> Tileset
}
```

Why an actor: the three caches are mutable state shared by every call, and callers will use one client from many tasks (a search per keystroke, a `place(origin:)` per row). An actor makes that safe without a lock and makes the cache's "lowest URL wins" rule easy to keep honest. Actor reentrancy during `await` is acceptable here: the worst case is two concurrent searches both missing the tile-list cache and both fetching, which the contract permits (§14). Tile fetches themselves run as child tasks of a `TaskGroup` outside the actor, so the actor is not held while bytes arrive.

```swift
public enum Region: Sendable, Hashable {
    /// Radius in metres.
    case circle(lat: Double, lon: Double, radius: Double)
    /// Degrees. minLon > maxLon crosses the antimeridian.
    case bbox(minLon: Double, minLat: Double, maxLon: Double, maxLat: Double)
}

public enum SortMode: String, Sendable, CaseIterable { case fused, distance, similarity }

public struct SearchResult: Sendable, Equatable {
    public var places: [SearchHit]
    public var complete: Bool
    public var overview: Bool
    public var tiles: TileCounts
    public struct TileCounts: Sendable, Equatable { public var fetched: Int; public var failed: Int }
}

public struct SearchHit: Sendable, Equatable {
    public var origin: String?
    public var place: JSONObject
    public var importance: Int64?
    public var distance: Double      // metres
    public var score: Double?        // 0...1, nil without text
}

public struct PlaceRecord: Sendable, Equatable {
    public var origin: String
    public var place: JSONObject
    public var importance: Int64?
}

public struct CollectionRef: Sendable, Equatable, Codable { public var dataset: String?; public var collection: String? }

public struct ServiceDescription: Sendable, Equatable, Codable {
    public var did: String?
    public var tilesets: [ServedTileset]        // empty when missing
    public struct ServedTileset: Sendable, Equatable, Codable { public var slug: String?; public var collections: [CollectionRef] }
}

public struct CollectionAttribution: Sendable, Equatable, Codable {
    public var dataset: String?, collection: String?
    public var release: String?, source: String?, licenses: [String]?, attribution: String?
}

public struct CollectionInfo: Sendable, Equatable, Codable {
    // the CollectionAttribution fields, plus:
    public var recordCount: Int64?, locationFormats: [String]?, containmentTypes: [String]?
    public var categories: [CategoryCount]?, attributes: [String]?
    public struct CategoryCount: Sendable, Equatable, Codable { public var value: String?; public var count: Int64? }
}

public struct Tileset: Sendable, Equatable, Codable {
    public var slug: String?
    public var publishedAt: String?
    public var extent: Extent?
    public var collections: [CollectionInfo]    // empty when missing
    public var references: [CollectionAttribution]?
    public struct Extent: Sendable, Equatable, Codable { public var north: String?, south: String?, east: String?, west: String? }
}
```

Every field of the describe types is optional, and the client's decoding of them is written by hand rather than synthesized: each field is read with `try?` from a keyed container, so a missing field or one of the wrong type is `nil`; the three lists the lexicon requires (`tilesets`, `ServedTileset.collections`, `Tileset.collections`) default to empty, and an optional list is `nil` when missing or not an array; and an array element that fails to decode is dropped rather than failing the array (decode `[JSONValue]` and map). Unknown keys are ignored, which keyed containers do by default. This is the contract's robustness rule (§1): the server may add, drop or retype a field the app does not read without the call failing. The `Codable` conformance stays for apps that persist what they fetched; the lenient path is the one the client uses on a response.

`importance` is `Int64`, not `Int`: `Int` is 32 bits on arm64_32, which is what watchOS runs on, and cannot hold the range. It is read from `JSONValue.number`, a `Double`, so precision beyond 2^53 is lost exactly as in the JavaScript client; the contract's 64-bit decoding (§1) is about range, and that is what this port gives. `publishedAt` and the extent's edges stay strings, as served; parsing dates and coordinates is the app's business, and the extent is a lexicon bbox whose values are strings.

### Place values

A place is served as arbitrary JSON and must be surfaced untouched (contract §1). `[String: Any]` can't be `Sendable` or `Equatable`, so the package defines its own JSON model:

```swift
public enum JSONValue: Sendable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)
}
public typealias JSONObject = [String: JSONValue]

extension JSONValue {
    public subscript(key: String) -> JSONValue? { get }   // nil unless .object
    public subscript(index: Int) -> JSONValue? { get }    // nil unless .array and in range
    public var stringValue: String? { get }
    public var doubleValue: Double? { get }
    public var boolValue: Bool? { get }
    public var arrayValue: [JSONValue]? { get }
    public var objectValue: JSONObject? { get }
}
```

Numbers decode as `Double`, which loses integers beyond 2^53 exactly as the JavaScript client does. Key order is not preserved, which the contract does not require. The `Codable` conformance must try `Bool` before `Double` and `Double` before `String` when decoding a single value, and must encode `.null` as JSON null, not as a missing key.

`SearchHit.place["name"]?.stringValue` is how an app reads a name. A typed `Place` struct is a reasonable later addition on top of `JSONObject`, not a replacement for it.

Tile records are read from `JSONValue`, not through `Codable`: a record that is not an object, or whose `value` is not an object, is skipped and the tile stays used (contract §4.4); a `uri` that is not a string and an `importance` that is not a number read as `nil`, and a non-integer importance truncates toward zero as `Int64(d.rounded(.towardZero))`, reading as `nil` when outside `Int64`'s range (§1). A `getTiles` body with no `tiles` array has no usable tile list and throws `DecodingError` (§1); entries of `tiles` that are not strings are skipped.

### Errors

```swift
/// A non-2xx answer from the server. `code` is the server's error name, or "HttpError" (contract §1).
public struct AtgeoError: Error, Sendable, Equatable {
    public let code: String
    public let message: String
}

/// A bad argument, raised before any request (contract §3).
public enum AtgeoArgumentError: Error, Sendable, Equatable {
    case invalidRegion(String)        // the message names what was wrong
    case similarityRequiresText
}
```

`AtgeoArgumentError` is a separate type rather than more `AtgeoError` codes so that the `code` namespace stays the server's. The JS client throws `TypeError` for the same reason.

Network failures throw `URLError` (or whatever the injected transport throws) unwrapped. A 2xx body that is not JSON, or has no usable body in the contract's narrow sense (§1: no `tiles` array, no `record` object, a describe body that is not an object), throws `DecodingError` unwrapped; nothing else about a body's shape throws. For tiles, either counts as a failed tile. Cancellation throws `CancellationError` or `URLError(.cancelled)`, whichever reached the call first; callers should test `Task.isCancelled` rather than match the error.

## 4. Transport

```swift
public struct HTTPResponse: Sendable {
    public var status: Int
    public var body: Data
}

public protocol HTTPTransport: Sendable {
    /// GET the URL exactly as given. Must throw on cancellation. Must not follow its own caching policy by default.
    func get(_ url: URL) async throws -> HTTPResponse
}

public struct URLSessionTransport: HTTPTransport {
    public init(session: URLSession = URLSessionTransport.defaultSession)
    public static let defaultSession: URLSession   // ephemeral configuration, urlCache nil, no cookies
}
```

The default session is built from `URLSessionConfiguration.ephemeral` with `urlCache = nil` and `requestCachePolicy = .reloadIgnoringLocalCacheData`. This keeps the contract's no-persistence default (§10, §14): the JS client starts cold on every launch, and so must this one unless the app opts in by passing a session with a cache. It also keeps the "which tiles did this client fetch before" exposure to what the contract describes (§12). An app that wants a disk cache passes its own session and accepts that the one-hour tile-list expiry then interacts with HTTP caching headers.

On Linux, `URLSession` comes from `FoundationNetworking`; import it conditionally.

XRPC URLs are built with `URLComponents`, but not through `queryItems`: that setter leaves `+` raw, because RFC 3986 allows it in a query, and a form-decoding server reads a raw `+` as a space. The contract requires `+` encoded (§1). Percent-encode each name and value with `addingPercentEncoding(withAllowedCharacters:)` over the unreserved characters only (`A-Z a-z 0-9 - . _ ~`), which also encodes `,` and `:` as the reference does, and assign `percentEncodedQueryItems`. Never build query strings by string interpolation.

The transport reads the whole body before checking the status, so that an error body is always available for `AtgeoError` (§1). The tile cache measures a tile as `body.count` bytes (§10). `URLSession`'s default 60-second request timeout stays: a timeout is a network failure, which the contract allows (§14), and inside a tile fetch it is a failed tile.

## 5. Concurrency and cancellation

- The actor serialises cache reads and writes.
- The two `getTiles` calls for an antimeridian-crossing region run in an `async let` pair. Either failing fails the search; the other is cancelled by structured concurrency (allowed, §14).
- Tiles are fetched in a `withThrowingTaskGroup` that keeps at most 8 child tasks running: add the first 8, then add one more each time one finishes, in URL order. Each child returns `(url, records?)`; a failure returns `nil` and is counted, never thrown, unless `Task.isCancelled`, in which case the child rethrows and the group fails the search.
- Cache lookups happen on the actor before a child is added, so a cached tile never becomes a request. Cache writes happen on the actor as children complete. The records are assembled in URL order from a dictionary after the group finishes, so completion order never affects results (§4.3).
- Nothing in the client blocks a thread. CPU work (normalizing, scoring) runs on the actor; for a region with tens of thousands of records this is milliseconds, and a caller who cares can wrap the call in a detached task.

Cancellation: a `Task` cancelled during a request sees `URLSession` abort the request and the error propagate. A fully cached call does not check cancellation and completes (§11); do not add `try Task.checkCancellation()` at the top of `searchPlaces`.

## 6. Implementing the contract in Swift

Pointers for the parts where Swift's defaults would give the wrong answer. Everything else is a direct transcription of the reference.

### Normalization (contract §7)

```swift
private static let whitespace: Set<Unicode.Scalar> = [
    "\u{09}", "\u{0A}", "\u{0B}", "\u{0C}", "\u{0D}", "\u{20}", "\u{A0}", "\u{1680}",
    "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}", "\u{2006}",
    "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}", "\u{2028}", "\u{2029}", "\u{202F}",
    "\u{205F}", "\u{3000}", "\u{FEFF}",
]

func normalize(_ s: String) -> String {
    let folded = s.lowercased().decomposedStringWithCompatibilityMapping   // 1. lowercase, 2. NFKD
    var out = String.UnicodeScalarView()
    var pendingSpace = false
    for u in folded.unicodeScalars {
        if u.properties.generalCategory == .nonspacingMark { continue }     // 3. drop Mn
        if whitespace.contains(u) { pendingSpace = !out.isEmpty; continue } // 4. collapse and trim
        if pendingSpace { out.append(" "); pendingSpace = false }
        out.append(u)
    }
    return String(out)
}
```

`lowercased()` is Foundation-free and locale-independent, and uses full case mapping, so `İ` becomes `i` + U+0307 as the contract requires. It maps scalar by scalar through `Unicode.Scalar.Properties.lowercaseMapping`, which cannot apply the context-sensitive Final_Sigma rule, so expect `ΟΔΟΣ` to come out `οδοσ` where the contract says `οδος` (§7). The fixture has no sigma case, so the port can pass 30/30 and still differ here; check it on the first toolchain run. If it differs, apply Final_Sigma by hand while lowercasing: only a U+03C3 that came from a U+03A3 in the input, and that is preceded by a cased letter (skipping case-ignorable scalars) and not followed by one, becomes U+03C2, as SpecialCasing.txt defines it. A lowercase sigma already in the input is left alone, which is what V8 does. Add the three cases the contract names (`ΟΔΟΣ`, `İstanbul`, `ẞ`) to the port's own tests. `decomposedStringWithCompatibilityMapping` is Foundation's NFKD and exists on Linux. The whitespace set is spelled out because neither `Character.isWhitespace` nor `\s` in Swift `Regex` matches JavaScript's set: both include U+0085 and exclude U+FEFF. Do not use `CharacterSet.whitespacesAndNewlines` either.

Run `normalize.json` early. If a case fails on one platform and passes on another, that is Unicode version skew between ICU builds; record it, and if the maintainer agrees, add the case to the port's known-skew list rather than changing the algorithm.

### Jaro-Winkler (contract §7)

Operate on `Array(a.utf16)` and `Array(b.utf16)`. Not `Array(a)` (grapheme clusters) and not `unicodeScalars`; the fixtures and the emoji example in the contract only hold for UTF-16 code units. Use `[Bool]` match arrays, not sets.

### Numbers and trigonometry (contract §3, §6)

- `Double(someString)` rejects leading whitespace and trailing text; the contract allows that strictness (§5). It accepts `inf`, `infinity` and `nan` in any case, so check `isFinite` after parsing, as the reference does. Accept `.number` and `.string` JSON values; anything else is no location.
- `round3`: `(x * 1000).rounded() / 1000`. The default rounding rule is `.toNearestOrAwayFromZero`, which agrees with `Math.round` for the non-negative scores it is applied to.
- Snapping: `(x * 100).rounded()` for the epsilon test, `.rounded(.down)` and `.rounded(.up)` for floor and ceil. Format with `String(format: "%.2f", units / 100)` after mapping `-0.0` to `0.0`; `%.2f` prints `-0.00` for negative zero.
- Use `Foundation.sin`, `cos`, `asin`, `atan2`, `sqrt`. Compare the worked distance tables to 1e-6 relative, containment exactly.

### String comparison and equality

Swift `String` compares, hashes and orders by Unicode canonical equivalence: a precomposed `é` equals `e` + U+0301, and `<` follows normalized scalar order, not UTF-16 code units. The contract wants ordinal code-unit semantics everywhere it compares strings, so:

- sort tile URLs with `urls.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }`, not `sorted()`, and compare origins in `byOrigin` the same way;
- key the dedupe set, and the `find(key:)` scan, by code units (a `[UInt16]` key, or a wrapper whose `==` and `hash` use `utf16`), so that two origins differing only in normalization form stay distinct, as they do in JS;
- compare fixture outputs as `Array(got.utf16) == Array(expected.utf16)`; `==` on `String` would pass a port that skipped NFKD.

### Ranking (contract §8)

Swift's `sort` is documented stable on current toolchains, but add the input index as a final comparator anyway so the guarantee does not depend on the toolchain. Implement the comparators as `(SearchHit, SearchHit) -> Int` and fold them exactly as the reference does; do not translate into a single `<` with early returns, which is where ports usually drop a tie-break.

### Caches (contract §10)

`TileCache` is an ordered dictionary: a `[URL: Entry]` plus a doubly linked list or an array of keys kept in recency order. For 50 MiB of tiles the key count is small (hundreds), so a `[String]` with `removeAll(where:)` on touch is fine and simpler than a linked list. `TtlCache` takes a `now: @Sendable () -> Date`; the public initializer passes `Date.init`, an internal initializer lets tests pass a clock.

`find(key:)` for `place(origin:)` scans every cached tile and keeps the match from the lowest URL (by UTF-16 order), without touching recency (§10).

## 7. Testing

Framework: Swift Testing (`import Testing`), which ships with the Swift 6 toolchains the package requires (section 2). Fixtures load through `Bundle.module`, so declare `Tests/AtgeoTests/Fixtures` as a resource in `Package.swift`.

The fake server is an `HTTPTransport` that:

- is configured with tilesets (slug, collections, tiles with records), a `tilesFor` override, a `failTiles` list, a `server` base, and `goOffline()`;
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors;
- records every request (`URL`, method, headers, body) for the privacy tests (§12);
- validates its own traffic. There is no Swift lexicon validator; implement the contract's minimum (§13): parameter names, the `bbox` regular expression, required response fields. Keep the lexicon JSON vendored regardless so that a validator can be added later and so that `SOURCE` says which garganorn commit the fake is modelled on.

Test files map one to one onto the reference's `test/*.test.ts`, with the same `describe`/`it` names turned into suites and test names, so that a reviewer can diff coverage by eye. The fixture tests (`normalize.json`, `jaro-winkler.json`, `ranking-scenarios.json`) are table-driven with `@Test(arguments:)`.

An end-to-end script against a local garganorn (`ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION`, `ATGEO_REGION`, same variables as `scripts/e2e.ts`) lives in `Scripts/e2e.swift` and is not part of `swift test`.

CI: GitHub Actions, two jobs. `macos-latest` with the current Xcode runs `swift build -Xswiftc -strict-concurrency=complete` and `swift test`; `ubuntu-latest` with the `swift:6` container runs the same. Both must pass; Linux is where the Foundation differences show up.

## 8. Decisions and open questions

| Decision | Choice | Why |
|---|---|---|
| Client type | `actor` | shared mutable caches; strict-concurrency clean |
| Place representation | `JSONValue` enum | `Sendable`, `Equatable`, untouched JSON |
| Importance type | `Int64` | `Int` is 32-bit on watchOS (arm64_32); the contract wants 64 |
| Tools version | 6.0, language mode 6 | Swift Testing and strict concurrency without a second build configuration |
| Query encoding | manual, via `percentEncodedQueryItems` | `queryItems` leaves `+` raw |
| Default transport caching | off | contract's no-persistence default; opt in by passing a session |
| Argument errors | separate `AtgeoArgumentError` | keeps `AtgeoError.code` the server's namespace |
| `getPlace` name | `place(origin:)` | API guidelines; mapped in the table above |
| Minimum platforms | iOS 15 / macOS 12 | `URLSession` async API |

Open:

1. Whether `Region.circle` should take a `CLLocationCoordinate2D` overload. Leaning no: it drags in CoreLocation, which is absent on Linux, and the app can pass `.latitude`/`.longitude` itself.
2. Whether to ship a typed `Place` view (`name`, `variants`, `locations`, `relations`) over `JSONObject` in the first release. It is useful and cheap, but it is a second schema to keep in step with the lexicon. Proposed: a later minor version.
3. The default cache budget on iOS. The contract keeps 50 MiB (§15); watchOS may want less. Expose the option, keep the default, revisit with numbers.
