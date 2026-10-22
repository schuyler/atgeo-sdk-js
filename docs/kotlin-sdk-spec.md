# Kotlin SDK specification

A Kotlin port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the library, its public API, and the decisions that are specific to Kotlin and the JVM. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: proposal. Nothing here has been built. The normalization and Jaro-Winkler recipes in section 6 have been run on a JVM against `fixtures/normalize.json` (30/30) and `fixtures/jaro-winkler.json` (33/33) at the commit this was written against, so those two pieces are known to be portable as written. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Kotlin: `suspend` functions, structured concurrency, coroutine cancellation, immutable data classes, no checked-exception ceremony.
- Android and plain JVM from one artifact, with the smallest dependency footprint that gets there: `kotlinx-coroutines-core` and `kotlinx-serialization-json`, and nothing for HTTP by default.

Non-goals for the first release: persistence, Kotlin Multiplatform targets, a Compose layer, Java-friendly overloads (`@JvmOverloads` can come later; Java callers get the suspend functions through a `CompletableFuture` adapter if anyone asks).

The design keeps the Multiplatform door open: the public API uses only Kotlin stdlib, coroutines and `kotlinx.serialization` types, and the JVM-only pieces sit behind internal `expect`-shaped seams: `java.text.Normalizer` and `Character.getType(int)` for normalization (`Char.category` would do for the BMP, but nonspacing marks such as the variation selectors U+E0100 to U+E01EF are supplementary and need the code-point form), and the default `HttpURLConnection` transport with its `URLEncoder`. Everything else, bbox formatting included (section 6), is common Kotlin. Going Multiplatform later means supplying those seams for other targets, not redesigning.

## 2. Artifact

Repository: `schuyler/atgeo-sdk-kotlin` (assumed; rename at will). Gradle project with one module, group `org.atgeo`, artifact `atgeo-client`, package `org.atgeo.client`.

```
build.gradle.kts
src/main/kotlin/org/atgeo/client/
  AtgeoClient.kt        the client; search pipeline (contract §4)
  Region.kt             Region, validation, centre, circle box, snapping (§3)
  Locations.kt          locate, distanceTo, inRegion (§5, §6)
  Text.kt               normalize, jaroWinkler, textScore (§7)
  Rank.kt               hit construction and comparators (§8)
  Cache.kt              TileCache (LRU) and TtlCache (§10)
  Transport.kt          HttpTransport, HttpUrlConnectionTransport, XRPC URL building, AtgeoException (§1)
  Types.kt              SearchResult, SearchHit, PlaceRecord, ServiceDescription, Tileset, …
src/test/kotlin/org/atgeo/client/
  FakeServer.kt         request-capturing HttpTransport (§13)
  *Test.kt              one file per reference test file
src/test/resources/fixtures/    vendored from atgeo-sdk-js: fixtures/*.json, test/lexicon/*.json, SOURCE
```

Toolchain: Kotlin 2.x (2.4 at the time of writing), JVM target 11 (the floor that keeps server-side JVM users happy without desugaring), Android `minSdk` 24 and `compileSdk` current; Gradle 9 through the wrapper. The library is a plain Kotlin/JVM module, not an Android library: it touches no Android API, so it needs no `AndroidManifest`, no resources and no AGP, and one artifact serves both.

Being a JVM module cuts both ways. The code compiles against the JDK's class library, so a call to a method Android gained after API 24 (`InputStream.readAllBytes()` and `URLEncoder.encode(String, Charset)` are both API 33) compiles, passes every test, and throws `NoSuchMethodError` on a device; neither the Kotlin compiler nor Android Lint, which does not run on a JVM module, can see it. The rule is therefore the JDK 8 API surface plus the Kotlin stdlib in `src/main`, enforced by the animalsniffer Gradle plugin (`ru.vyarus.animalsniffer`) checking against the `com.toasttab.android:gummy-bears-api-24` signature, so that such a call fails `gradle build`. Where the stdlib has an equivalent (`readBytes()` for `readAllBytes()`), use it.

An `android-sample/` app proves the artifact runs on a device and is where the OkHttp adapter lives as an example. It is its own Gradle build, not a subproject of the library's: it consumes the library through `includeBuild("..")`, so AGP is never applied in the library build and `gradle test` needs no Android SDK. CI builds it as a separate step (section 7).

Dependencies: `org.jetbrains.kotlinx:kotlinx-coroutines-core`, `org.jetbrains.kotlinx:kotlinx-serialization-json`. Nothing else at runtime.

Distribution during beta mirrors the JS client: not on Maven Central. Options, cheapest first: JitPack (free for public repos, resolves `com.github.schuyler:atgeo-sdk-kotlin:<commit>` with no publishing step), a Gradle `includeBuild` of a checkout, or GitHub Packages (needs a token even to read). Pin a full commit, as the JS README says; the API is still moving. Publish to Maven Central under `org.atgeo` once the wire contract settles.

## 3. Public API

Names match the JS client where Kotlin convention allows. `getPlace` stays `getPlace` (Kotlin has no objection to the verb, and it is what the XRPC query is called).

```kotlin
class AtgeoClient(
    server: String = DEFAULT_SERVER,
    transport: HttpTransport = HttpUrlConnectionTransport(),
    cacheBudgetBytes: Long = DEFAULT_CACHE_BUDGET_BYTES,
) {
    companion object {
        const val DEFAULT_SERVER = "https://places.atgeo.org"
        const val DEFAULT_CACHE_BUDGET_BYTES = 50L * 1024 * 1024
    }

    suspend fun searchPlaces(
        region: Region,
        text: String? = null,
        dataset: String? = null,
        collection: String? = null,
        sort: SortMode = SortMode.FUSED,
    ): SearchResult

    suspend fun getPlace(origin: String): PlaceRecord
    suspend fun describeService(): ServiceDescription
    suspend fun describeTileset(slug: String): Tileset
}
```

The client is thread-safe and meant to be shared: one per server for the life of the process. Its caches are guarded by a `kotlinx.coroutines.sync.Mutex`. The critical sections are short and never suspend, so on the JVM alone a plain lock would serve as well; the `Mutex` is chosen because it is common Kotlin, which keeps the Multiplatform door open. It is never held across a transport call (section 5).

```kotlin
sealed interface Region {
    /** Radius in metres. */
    data class Circle(val lat: Double, val lon: Double, val radius: Double) : Region
    /** Degrees. minLon > maxLon crosses the antimeridian. */
    data class Bbox(val minLon: Double, val minLat: Double, val maxLon: Double, val maxLat: Double) : Region
}

enum class SortMode { FUSED, DISTANCE, SIMILARITY }

data class SearchResult(
    val places: List<SearchHit>,
    val complete: Boolean,
    val overview: Boolean,
    val tiles: TileCounts,
) { data class TileCounts(val fetched: Int, val failed: Int) }

data class SearchHit(
    val origin: String?,
    val place: JsonObject,
    val importance: Long?,
    val distance: Double,      // metres
    val score: Double?,        // 0..1, null without text
)

data class PlaceRecord(val origin: String, val place: JsonObject, val importance: Long?)

@Serializable data class CollectionRef(val dataset: String? = null, val collection: String? = null)

@Serializable data class ServiceDescription(val did: String? = null, val tilesets: List<ServedTileset> = emptyList()) {
    @Serializable data class ServedTileset(val slug: String? = null, val collections: List<CollectionRef> = emptyList())
}

@Serializable data class CollectionAttribution(
    val dataset: String? = null, val collection: String? = null,
    val release: String? = null, val source: String? = null,
    val licenses: List<String>? = null, val attribution: String? = null,
)

@Serializable data class CollectionInfo(
    val dataset: String? = null, val collection: String? = null,
    val release: String? = null, val source: String? = null,
    val licenses: List<String>? = null, val attribution: String? = null,
    val recordCount: Long? = null, val locationFormats: List<String>? = null,
    val containmentTypes: List<String>? = null, val categories: List<CategoryCount>? = null,
    val attributes: List<String>? = null,
) { @Serializable data class CategoryCount(val value: String? = null, val count: Long? = null) }

@Serializable data class Tileset(
    val slug: String? = null,
    val publishedAt: String? = null,
    val extent: Extent? = null,
    val collections: List<CollectionInfo> = emptyList(),
    val references: List<CollectionAttribution>? = null,
) { @Serializable data class Extent(val north: String? = null, val south: String? = null, val east: String? = null, val west: String? = null) }
```

`importance` is `Long`, not `Int`: the lexicon says integer without a range, and the JavaScript client carries 53 bits (contract §1). `publishedAt` and the extent's edges stay strings, as served.

Every field of the describe types is nullable with a null default, and the three lists the lexicon requires (`tilesets`, and `collections` in both places) default to empty, so that a missing field never fails a call. `kotlinx.serialization` still throws on a field of the wrong type, and the contract wants that read as absent (§1), so the client does not decode a server response through these classes' generated serializers. It parses the body with `Json.parseToJsonElement` and maps the `JsonObject` by hand: a missing or wrong-typed field becomes null, a list the lexicon requires (`tilesets`, `collections`) that is missing or not an array becomes empty, an optional list becomes null, and a list element that does not map is dropped. Reach a primitive with `as? JsonPrimitive`, never `.jsonPrimitive`, which throws on an object or array (the reference does receive `uri: {}`), then check its kind before reading it: `JsonPrimitive.longOrNull` is `content.toLongOrNull()`, which reads the string primitive `"5"` as 5, so a string field is `takeIf { it.isString }?.content` and a number field is `takeUnless { it.isString }?.doubleOrNull`. `@Serializable` stays on the classes for apps that want to persist them.

### Place values

A place is arbitrary JSON and must be surfaced untouched (contract §1). `kotlinx.serialization.json.JsonObject` is exactly that: immutable, structurally equal, and preserving every key and nested value as served, including key order. `SearchHit.place["name"]?.jsonPrimitive?.contentOrNull` is how an app reads a name. A typed `Place` class is a reasonable later addition on top of `JsonObject`, not a replacement for it.

Tile records are read from the parsed `JsonObject` into an internal `TileRecord(value: JsonObject, uri: String?, importance: Long?)`; the rest of the payload is dropped. A record that is not an object, or whose `value` is not one, is skipped and the tile stays used (contract §4.4); a `uri` that is not a string and an `importance` that is a string primitive or not a number read as null, and a non-integer importance truncates toward zero: read it as `takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() && abs(it) < 9.223372036854775807E18 }?.toLong()`, since `longOrNull` returns null for `1.9` and reads `"7"` as 7, and `Double.toLong()` saturates where the contract wants absent (§1). A `getTiles` body with no `tiles` array has no usable tile list and raises `SerializationException` (§1); entries of `tiles` that are not strings are skipped. `overview` follows the contract's truthiness rule (§1), which no single `kotlinx.serialization` accessor gives (`booleanOrNull` reads `0` and `""` as null, not false): an absent key and `JsonNull` are false; a string primitive is `content.isNotEmpty()`; a boolean primitive is its value; a number primitive is `doubleOrNull != 0.0`, which also covers `-0`; a `JsonObject` or `JsonArray` is true.

### Errors

```kotlin
/** A non-2xx answer from the server. `code` is the server's error name, or "HttpError" (contract §1). */
class AtgeoException(val code: String, message: String) : RuntimeException(message)
```

Bad arguments (contract §3) throw `IllegalArgumentException` from `require()` calls at the top of `searchPlaces`, in the contract's order, before anything is looked up or fetched; the observable rule is that no request is made. This matches the JS client's `TypeError` in spirit: a programming error, kept out of `AtgeoException`'s code namespace.

Network failures throw `IOException` (or whatever the injected transport throws) unwrapped. A 2xx body that is not JSON, or has no usable body in the contract's narrow sense (§1: no `tiles` array, no `record` object, a describe body that is not an object), throws `SerializationException` unwrapped; nothing else about a body's shape throws. For tiles, either counts as a failed tile. The search's own cancellation must propagate anywhere the client catches `Throwable` (the tile-fetch loop is the one such place); section 5 gives the exact rule, which is not "rethrow every `CancellationException`".

## 4. Transport

```kotlin
class HttpResponse(val status: Int, val body: ByteArray)

fun interface HttpTransport {
    /** GET the URL exactly as given. Must respond to coroutine cancellation. Must not cache by default. */
    suspend fun get(url: String): HttpResponse
}

class HttpUrlConnectionTransport(
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 30_000,
) : HttpTransport
```

The default transport uses `java.net.HttpURLConnection` because it is on every JVM and every Android version with no dependency, which is the cost-conscious default. `HttpURLConnection` is blocking, and its reads do not respond to thread interruption; the only way to unblock one from outside is `disconnect()` from another thread. So the transport wraps the call in `suspendCancellableCoroutine`, registers `invokeOnCancellation { connection.disconnect() }`, and runs the blocking open-and-read on `Dispatchers.IO.asExecutor()`, resuming the continuation with the response or the exception. A resume that arrives after cancellation is ignored by `CancellableContinuation`, so the `IOException` the disconnected read throws is harmless. `withContext(Dispatchers.IO)` on its own is not enough: nothing would call `disconnect()`, and the cancelled coroutine would wait out the read timeout. The transport sets `useCaches = false`; sends `Accept: application/json`; reads the whole body with `readBytes()` before looking at the status (contract §1); and reads error bodies from `errorStream`, which is null for an empty error body, so that a 4xx with a JSON error body becomes an `AtgeoException` with the server's code.

The timeouts are a freedom the contract grants (§14): the reference relies on its platform's `fetch` defaults (undici's in Node, the browser's in a browser), so a tile that times out is a failed tile here where it might hang there.

`HttpURLConnection` on Android has no HTTP/2 and a dated TLS stack on old devices. Apps that already ship OkHttp should pass a ten-line `OkHttpTransport`, which the `android-sample/` module provides as copy-paste code rather than as a dependency of the library. Any transport an app supplies must disable its own response cache or accept that the contract's no-persistence default (§10, §14) no longer holds.

XRPC URLs are built by percent-encoding each query value with `java.net.URLEncoder.encode(value, "UTF-8")` (the `Charset` overload is Java 10 and Android API 33, above `minSdk`; the API check in section 2 catches this class of mistake) and then replacing `+` with `%20`. That is form encoding (`,` → `%2C`, `:` → `%3A`) with spaces as `%20`; the contract allows either (§1). Never build query strings by string template without encoding.

The tile cache measures a tile as `body.size` bytes (§10).

## 5. Concurrency and cancellation

- `searchPlaces` runs inside `coroutineScope`. The two `getTiles` calls for an antimeridian-crossing region are `async` siblings; if one throws, structured concurrency cancels the other and the search fails with the first error (allowed, §14).
- Tiles are fetched as `async` children sharing a `Semaphore(8)`, launched in URL order. Each child catches `Throwable`, calls `coroutineContext.ensureActive()` inside the catch so that its own cancellation propagates, and otherwise returns `null` for the failed tile. Catching everything but `CancellationException` is not the same rule: a transport that uses `withTimeout` throws `TimeoutCancellationException`, which is a `CancellationException`, and the search would fail instead of counting one failed tile. The reference's check is `signal.aborted`, the search's own cancellation and nothing else. Results are collected with `awaitAll()` and assembled in URL order, so completion order never affects results (§4.3).
- The tile cache is checked under the mutex before launching a child, so a cached tile never becomes a request. Writes happen under the mutex as children complete. The mutex is never held across a transport call.
- Nothing blocks a dispatcher thread except inside the default transport's `Dispatchers.IO` block. The CPU work does not run on the caller's dispatcher either: the tile children are started with `async(Dispatchers.Default)`, so a tile body is parsed and mapped off the calling thread, and dedupe, filtering, scoring and ranking run inside `withContext(Dispatchers.Default)`. The reason is Android: an app searches from `Dispatchers.Main`, and `async` children otherwise inherit that context, which would put megabytes of JSON parsing and tens of thousands of Jaro-Winkler comparisons on the main thread. On a server JVM the switch costs a dispatch and nothing else. `Dispatchers.Default` is common Kotlin, so the Multiplatform door stays open.

Cancellation: cancelling the calling coroutine cancels every in-flight request through the transport and the search throws `CancellationException`. A fully cached call takes an uncontended mutex fast path and completes normally (§11); do not add `ensureActive()` at the top of `searchPlaces`. The contract does not require this behaviour and the tests must not assert it, since `Mutex.lock` may suspend under contention.

## 6. Implementing the contract in Kotlin

Pointers for the parts where the JVM's defaults would give the wrong answer. Everything else is a direct transcription of the reference.

### Normalization (contract §7)

Verified against all 30 fixture cases on a JVM (JDK 21, Kotlin 2.2):

```kotlin
private val WHITESPACE: Set<Int> = (
    listOf(0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680) +
    (0x2000..0x200A) + listOf(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
).toSet()

fun normalize(s: String): String {
    val folded = Normalizer.normalize(s.lowercase(), Normalizer.Form.NFKD)   // 1. lowercase, 2. NFKD
    val out = StringBuilder(folded.length)
    var pendingSpace = false
    var i = 0
    while (i < folded.length) {
        val cp = folded.codePointAt(i)
        i += Character.charCount(cp)
        if (Character.getType(cp) == Character.NON_SPACING_MARK.toInt()) continue   // 3. drop Mn
        if (cp in WHITESPACE) { pendingSpace = out.isNotEmpty(); continue }          // 4. collapse and trim
        if (pendingSpace) { out.append(' '); pendingSpace = false }
        out.appendCodePoint(cp)
    }
    return out.toString()
}
```

One pass over code points does steps 3 and 4 together: a whitespace run becomes a single space only when a non-space follows it, which also trims both ends. `String.lowercase()` is `toLowerCase(Locale.ROOT)`: locale-independent full case mapping through `SpecialCasing`, so `ΟΔΟΣ` gets its final sigma, `İ` becomes `i` + U+0307 and `ẞ` becomes `ß`, the three cases the contract names and the fixture does not cover (§7); `NormalizeTest` asserts all three. Never `toLowerCase()` with the default locale, which on a Turkish device turns `I` into dotless `ı`. The whitespace set is spelled out because Java's `\s` is ASCII-only by default, `UNICODE_CHARACTER_CLASS` matches a different set (it includes U+0085 and excludes U+FEFF), and Kotlin's `trim()` with no predicate uses `Char.isWhitespace`, which trims U+001C to U+001F and keeps U+FEFF; none of them can stand in for the loop.

`java.text.Normalizer` is in Android since API 9. Unicode version skew between the JDK, Android's ICU and V8 is possible at the margins; the fixture is the arbiter, and a case that fails only on one runtime is recorded as known skew rather than worked around in the algorithm.

### Jaro-Winkler (contract §7)

Verified against all 33 fixture cases on a JVM. Kotlin strings are UTF-16, so `s[i]` and `s.length` are already code units and the reference transcribes directly; do not convert to code points. Use `BooleanArray` for the match arrays.

### Numbers and trigonometry (contract §3, §6)

- Coordinates arrive as `JsonPrimitive`. Accept a string primitive via `toDoubleOrNull()` and a numeric primitive via `doubleOrNull`; anything else, a `JsonArray` included, is no location (contract §16). `toDoubleOrNull()` accepts a few things `parseFloat` would not (hex floats, `1.5f`, surrounding ASCII whitespace) and rejects trailing text; both are within the contract's freedom (§5). Check `isFinite()` after parsing. The port's `CONFORMANCE.md` lists the margins, as §5 asks: `toDoubleOrNull()` accepts surrounding ASCII whitespace, a trailing `f` or `d`, and hex floats such as `0x1p3`, which `parseFloat` does not; it rejects `1e`, `1.5abc` and `1_000`, where `parseFloat` reads 1, 1.5 and 1.
- `round3`: `Math.round(x * 1000) / 1000.0`. `Math.round(Double)` rounds half up, the same as `Math.round` in JavaScript, and returns `Long`.
- Snapping: `Math.round(x * 100)` for the epsilon test, `floor` and `ceil` from `kotlin.math`, all brought to `Long` hundredths. Format from the integer, not through a double: with `a = abs(units)`, the string is `(if (units < 0) "-" else "") + a / 100 + "." + (a % 100).toString().padStart(2, '0')`. That has no locale, no negative zero (`Math.round(-0.0 * 100)` is `0L`) and no floating point, and it is common Kotlin. `"%.2f".format(Locale.ROOT, units / 100.0)` gives the same strings on every worked example and is acceptable, but it needs the explicit locale (a German default would print `37,77`) and a guard against `-0.0`, which `%.2f` prints as `-0.00`.
- `kotlin.math.sin`, `cos`, `asin`, `atan2`, `sqrt` map to `java.lang.Math`, which may differ from V8's implementations in the last bit. Compare the worked distance tables to 1e-6 relative, containment exactly.
- The tile URL sort is `urls.sorted()`: `String.compareTo` compares UTF-16 code units, which is what the contract wants (§4.3).

### Ranking (contract §8)

`sortedWith` is stable (it is `java.util.Arrays.sort` on objects, a TimSort), but add the input index as a final `thenBy` anyway so the guarantee is in the code and not in a library contract. Build the comparator chain with `Comparator` and `thenComparing`/`thenBy` in exactly the order of the contract's table, and keep `byScore` on `round3` of the score; the usual porting mistake is to compare raw scores and lose the ties the reference has. Compare with `compareByDescending`/`compareValues`, not by subtraction: `(b.importance ?: 0) - (a.importance ?: 0)` overflows `Long` at the extremes, and the contract's comparator table describes an order, not arithmetic. One trap: `compareValues` and `thenBy { it.origin }` order nulls first, while the contract's `byOrigin` puts a null origin after every string (§8). Use `nullsLast(naturalOrder())` for that comparator; no fixture pins the null-against-string case, so the mistake would survive the suite.

### Caches (contract §10)

`TileCache` is a `LinkedHashMap<String, Entry>(16, 0.75f, true)` (access order) plus a running total, with eviction done by iterating from the eldest after each insert; `removeEldestEntry` is tempting but cannot evict more than one entry per insert, and a large tile must be able to evict several. `TtlCache` takes a `clock: () -> Long` (epoch millis); the public constructor of `AtgeoClient` passes `System::currentTimeMillis`, an `internal` constructor lets tests inject one.

`find(key)` for `getPlace` scans every cached tile and keeps the match from the lowest URL. Iterate the map's entries for this: iterating an access-ordered `LinkedHashMap` does not count as access, which is what §10 wants (`find` must not touch recency), and `get` would both reorder and throw `ConcurrentModificationException` mid-iteration.

## 7. Testing

Framework: `kotlin.test` over JUnit 5, with `kotlinx-coroutines-test` for `runTest`. Fixtures load from the test classpath (`src/test/resources/fixtures`).

The fake server is an `HttpTransport` that:

- is configured with tilesets (slug, collections, tiles with records), a `tilesFor` override, a `failTiles` list, a `server` base, and `goOffline()`;
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors;
- records every request URL for the privacy tests (§12). The `HttpTransport` seam carries a URL and nothing else: the method is always GET and there is never a body, so those are fixed by construction rather than recorded. Headers belong to the real transport and are outside the fake's view; the privacy requirement on them is met by the default transport adding only fixed headers of its own, which the transport test (below) checks against a loopback server;
- validates its own traffic. There is no JVM lexicon validator; implement the contract's minimum (§13): parameter names, the `bbox` regular expression, required response fields. Keep the lexicon JSON vendored regardless, with `SOURCE` naming the garganorn commit, so that a validator can be added later.

Test files map one to one onto the reference's `test/*.test.ts`, with the same `describe`/`it` names turned into nested classes and `@Test` names, so that a reviewer can diff coverage by eye. The fixture tests are `@TestFactory` dynamic tests, one per case, so a failure names the case. Two files have no reference counterpart: `RobustnessTest.kt`, which covers the contract's §16 behaviours (the reference crashes on them, so the JS suite cannot test them), and `HttpUrlConnectionTransportTest.kt` (next paragraph). `NormalizeTest` adds the three case-mapping cases the contract names (§7).

The default transport gets one small test of its own against a loopback HTTP server, since the fake replaces it everywhere else: a 4xx with a JSON error body, a 4xx with an empty body (`errorStream` is null then and must read as empty), a redirect, cancellation mid-request calling `disconnect()`, and the exact request headers it sends.

An end-to-end main against a local garganorn (`ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION`, `ATGEO_REGION`, the same variables as `scripts/e2e.ts`) lives under `src/e2e/` as a separate source set and is not part of `gradle test`.

CI: GitHub Actions on `ubuntu-latest`, `gradle build` (tests plus the animalsniffer API check) on JDK 17 and JDK 21 with the Gradle wrapper, validated by `gradle/actions/wrapper-validation`, plus a separate job that runs `gradle -p android-sample assembleDebug` to prove the artifact resolves and compiles from an Android module. No emulator in CI for the first release.

## 8. Decisions and open questions

| Decision | Choice | Why |
|---|---|---|
| Module type | plain Kotlin/JVM | no Android API used; one artifact for JVM and Android |
| Place representation | `JsonObject` | untouched JSON, structural equality, no extra type |
| Importance type | `Long` | lexicon integer with no range |
| Default transport | `HttpURLConnection`, caching off | zero dependencies; contract's no-persistence default |
| Argument errors | `IllegalArgumentException` | Kotlin convention; keeps `AtgeoException.code` the server's namespace |
| Cache lock | coroutine `Mutex` | common Kotlin, so it survives a Multiplatform move; the sections are microseconds and never suspend, so a JVM lock would also do |
| CPU work | `Dispatchers.Default` inside the client | Android callers search from `Main`; a dispatch costs nothing on a server |
| Android API floor | animalsniffer + `gummy-bears-api-24` | the compiler and Lint cannot see an API 33 call in a JVM module |
| Sample app | separate Gradle build via `includeBuild` | no AGP or Android SDK needed to build and test the library |
| Beta distribution | JitPack by commit | free, no publishing step, pins like the JS client |

Open:

1. Whether to go Multiplatform (`jvm` + `android` + `iosArm64`) from the start instead of after. It would let one codebase serve iOS too, which argues against writing the Swift port at all. The counter-argument is that iOS developers expect a SwiftPM package with Swift types, and a KMP framework gives them Objective-C-shaped ones. Proposed: JVM first, keep the seams (section 1), decide with a real iOS consumer in hand.
2. `@JvmOverloads` and a `CompletableFuture` facade for Java callers. Not until someone asks.
3. The default cache budget on Android. The contract keeps 50 MiB (§15). Expose the option, keep the default, revisit with numbers from a device.
