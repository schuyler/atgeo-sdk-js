# Kotlin SDK specification

A Kotlin port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the library, its public API, and the decisions that are specific to Kotlin and the JVM. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: proposal. Nothing here has been built. The normalization and Jaro-Winkler recipes in section 6 have been run on a JVM against `fixtures/normalize.json` (30/30) and `fixtures/jaro-winkler.json` (33/33) at the commit this was written against, so those two pieces are known to be portable as written. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Kotlin: `suspend` functions, structured concurrency, coroutine cancellation, immutable data classes, no checked-exception ceremony.
- Android and plain JVM from one artifact, with the smallest dependency footprint that gets there: `kotlinx-coroutines-core` and `kotlinx-serialization-json`, and nothing for HTTP by default.

Non-goals for the first release: persistence, Kotlin Multiplatform targets, a Compose layer, Java-friendly overloads (`@JvmOverloads` can come later; Java callers get the suspend functions through a `CompletableFuture` adapter if anyone asks).

The design keeps the Multiplatform door open: the public API uses only Kotlin stdlib, coroutines and `kotlinx.serialization` types, and the two JVM-only pieces (`java.text.Normalizer`, the default `HttpURLConnection` transport) sit behind internal `expect`-shaped seams. Going Multiplatform later means supplying those two for other targets, not redesigning.

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

Toolchain: Kotlin 2.x, JVM target 11 (the floor that keeps server-side JVM users happy without desugaring), Android `minSdk` 24 and `compileSdk` current. The library is a plain Kotlin/JVM module, not an Android library: it touches no Android API, so it needs no `AndroidManifest`, no resources and no AGP, and one artifact serves both. An `android-sample/` app in the repo proves it runs on a device and is where the OkHttp adapter lives as an example.

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

The client is thread-safe and meant to be shared: one per server for the life of the process. Its caches are guarded by a `kotlinx.coroutines.sync.Mutex`, never a JVM lock, so that holding one never blocks a dispatcher thread.

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

@Serializable data class CollectionRef(val dataset: String, val collection: String)

@Serializable data class ServiceDescription(val did: String, val tilesets: List<ServedTileset>) {
    @Serializable data class ServedTileset(val slug: String, val collections: List<CollectionRef>)
}

@Serializable data class CollectionAttribution(
    val dataset: String, val collection: String,
    val release: String? = null, val source: String? = null,
    val licenses: List<String>? = null, val attribution: String? = null,
)

@Serializable data class CollectionInfo(
    val dataset: String, val collection: String,
    val release: String? = null, val source: String? = null,
    val licenses: List<String>? = null, val attribution: String? = null,
    val recordCount: Long? = null, val locationFormats: List<String>? = null,
    val containmentTypes: List<String>? = null, val categories: List<CategoryCount>? = null,
    val attributes: List<String>? = null,
) { @Serializable data class CategoryCount(val value: String, val count: Long) }

@Serializable data class Tileset(
    val slug: String,
    val publishedAt: String? = null,
    val extent: Extent? = null,
    val collections: List<CollectionInfo>,
    val references: List<CollectionAttribution>? = null,
) { @Serializable data class Extent(val north: String, val south: String, val east: String, val west: String) }
```

`importance` is `Long`, not `Int`: the lexicon says integer without a range, and the JavaScript client carries 53 bits (contract §1). `publishedAt` and the extent's edges stay strings, as served.

Every `@Serializable` type is decoded with a `Json { ignoreUnknownKeys = true }` instance, so that a server adding a field does not break the client. The same instance is used everywhere; it is internal.

### Place values

A place is arbitrary JSON and must be surfaced untouched (contract §1). `kotlinx.serialization.json.JsonObject` is exactly that: immutable, structurally equal, and preserving every key and nested value as served, including key order. `SearchHit.place["name"]?.jsonPrimitive?.contentOrNull` is how an app reads a name. A typed `Place` class is a reasonable later addition on top of `JsonObject`, not a replacement for it.

Tile records are decoded into an internal `TileRecord(value: JsonObject, uri: String?, importance: Long?)`; the rest of the payload is dropped. A record whose `value` is not a JSON object is a malformed tile, and the tile counts as failed.

### Errors

```kotlin
/** A non-2xx answer from the server. `code` is the server's error name, or "HttpError" (contract §1). */
class AtgeoException(val code: String, message: String) : RuntimeException(message)
```

Bad arguments (contract §3) throw `IllegalArgumentException` from `require()`, before the first suspension point, so a caller sees them at the call site. This matches the JS client's `TypeError` in spirit: a programming error, kept out of `AtgeoException`'s code namespace.

Network failures throw `IOException` (or whatever the injected transport throws) unwrapped. A 2xx body that does not decode throws `SerializationException` unwrapped, except for tiles, where it counts as a failed tile. Cancellation throws `CancellationException` and must be rethrown, never swallowed, anywhere the client catches `Throwable` (the tile-fetch loop is the one such place).

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

The default transport uses `java.net.HttpURLConnection` because it is on every JVM and every Android version with no dependency, which is the cost-conscious default. It runs the blocking call under `withContext(Dispatchers.IO)` inside `suspendCancellableCoroutine`-style handling so that cancelling the coroutine calls `disconnect()` and the thread comes back; sets `useCaches = false`; sends `Accept: application/json`; reads the whole body before looking at the status (contract §1); and reads error bodies from `errorStream` so that a 4xx with a JSON error body becomes an `AtgeoException` with the server's code.

`HttpURLConnection` on Android has no HTTP/2 and a dated TLS stack on old devices. Apps that already ship OkHttp should pass a ten-line `OkHttpTransport`, which the `android-sample/` module provides as copy-paste code rather than as a dependency of the library. Any transport an app supplies must disable its own response cache or accept that the contract's no-persistence default (§10, §14) no longer holds.

XRPC URLs are built by percent-encoding each query value with `java.net.URLEncoder.encode(value, UTF_8)` and then replacing `+` with `%20`. That is form encoding (`,` → `%2C`, `:` → `%3A`) with spaces as `%20`; the contract allows either (§1). Never build query strings by string template without encoding.

The tile cache measures a tile as `body.size` bytes (§10).

## 5. Concurrency and cancellation

- `searchPlaces` runs inside `coroutineScope`. The two `getTiles` calls for an antimeridian-crossing region are `async` siblings; if one throws, structured concurrency cancels the other and the search fails with the first error (allowed, §14).
- Tiles are fetched as `async` children sharing a `Semaphore(8)`, launched in URL order. Each child catches everything but `CancellationException`, returns `null` for a failed tile, and never throws otherwise. Results are collected with `awaitAll()` and assembled in URL order, so completion order never affects results (§4.3).
- The tile cache is checked under the mutex before launching a child, so a cached tile never becomes a request. Writes happen under the mutex as children complete. The mutex is never held across a transport call.
- Nothing blocks a dispatcher thread except inside the default transport's `Dispatchers.IO` block. Normalizing and scoring run on whatever dispatcher called `searchPlaces`; for tens of thousands of records this is milliseconds, and a caller who cares wraps the call in `withContext(Dispatchers.Default)`.

Cancellation: cancelling the calling coroutine cancels every in-flight request through the transport and the search throws `CancellationException`. A fully cached call takes an uncontended mutex fast path and completes normally (§11); do not add `ensureActive()` at the top of `searchPlaces`. The contract does not require this behaviour and the tests must not assert it, since `Mutex.lock` may suspend under contention.

## 6. Implementing the contract in Kotlin

Pointers for the parts where the JVM's defaults would give the wrong answer. Everything else is a direct transcription of the reference.

### Normalization (contract §7)

Verified against all 30 fixture cases on a JVM:

```kotlin
private val WHITESPACE_CHARS: Set<Char> = (
    listOf('\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0', '\u1680') +
    ('\u2000'..'\u200A') + listOf('\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF')
).toSet()
private val WHITESPACE = Regex("[" + WHITESPACE_CHARS.joinToString("") { "\\u%04X".format(it.code) } + "]+")

fun normalize(s: String): String {
    val folded = Normalizer.normalize(s.lowercase(), Normalizer.Form.NFKD)   // 1. lowercase, 2. NFKD
    val sb = StringBuilder(folded.length)
    folded.codePoints().forEach { cp ->                                       // 3. drop Mn
        if (Character.getType(cp) != Character.NON_SPACING_MARK.toInt()) sb.appendCodePoint(cp)
    }
    return sb.toString().replace(WHITESPACE, " ").trim { it in WHITESPACE_CHARS }  // 4. collapse and trim
}
```

`String.lowercase()` is `toLowerCase(Locale.ROOT)`: locale-independent full case mapping, including final sigma and `İ`. Never `toLowerCase()` with the default locale, which on a Turkish device turns `I` into dotless `ı`. The whitespace set is spelled out because Java's `\s` is ASCII-only by default and `UNICODE_CHARACTER_CLASS` matches a different set (it includes U+0085 and excludes U+FEFF). `trim()` with no predicate trims `<= ' '`, which is wrong on both sides: write the predicate over the same set.

`java.text.Normalizer` is in Android since API 9. Unicode version skew between the JDK, Android's ICU and V8 is possible at the margins; the fixture is the arbiter, and a case that fails only on one runtime is recorded as known skew rather than worked around in the algorithm.

### Jaro-Winkler (contract §7)

Verified against all 33 fixture cases on a JVM. Kotlin strings are UTF-16, so `s[i]` and `s.length` are already code units and the reference transcribes directly; do not convert to code points. Use `BooleanArray` for the match arrays.

### Numbers and trigonometry (contract §3, §6)

- Coordinates arrive as `JsonPrimitive`. Accept a string primitive via `toDoubleOrNull()` and a numeric primitive via `doubleOrNull`; anything else is no location. `toDoubleOrNull()` accepts a few things `parseFloat` would not (hex floats, `1.5f`) and rejects trailing text; both are within the contract's freedom (§5). Check `isFinite()` after parsing.
- `round3`: `Math.round(x * 1000) / 1000.0`. `Math.round(Double)` rounds half up, the same as `Math.round` in JavaScript, and returns `Long`.
- Snapping: `Math.round(x * 100)` for the epsilon test, `floor` and `ceil` from `kotlin.math`. Format with `"%.2f".format(Locale.ROOT, units / 100.0)` after mapping `-0.0` to `0.0`; the locale matters (a German default locale would print `37,77`) and `%.2f` prints `-0.00` for negative zero.
- `kotlin.math.sin`, `cos`, `asin`, `atan2`, `sqrt` map to `java.lang.Math`, which may differ from V8's implementations in the last bit. Compare the worked distance tables to 1e-6 relative, containment exactly.
- The tile URL sort is `urls.sorted()`: `String.compareTo` compares UTF-16 code units, which is what the contract wants (§4.3).

### Ranking (contract §8)

`sortedWith` is stable (it is `java.util.Arrays.sort` on objects, a TimSort), but add the input index as a final `thenBy` anyway so the guarantee is in the code and not in a library contract. Build the comparator chain with `Comparator` and `thenComparing`/`thenBy` in exactly the order of the contract's table, and keep `byScore` on `round3` of the score; the usual porting mistake is to compare raw scores and lose the ties the reference has.

### Caches (contract §10)

`TileCache` is a `LinkedHashMap<String, Entry>(16, 0.75f, true)` (access order) plus a running total, with eviction done by iterating from the eldest after each insert; `removeEldestEntry` is tempting but cannot evict more than one entry per insert, and a large tile must be able to evict several. `TtlCache` takes a `clock: () -> Long` (epoch millis); the public constructor of `AtgeoClient` passes `System::currentTimeMillis`, an `internal` constructor lets tests inject one.

`find(key)` for `getPlace` scans every cached tile and keeps the match from the lowest URL.

## 7. Testing

Framework: `kotlin.test` over JUnit 5, with `kotlinx-coroutines-test` for `runTest`. Fixtures load from the test classpath (`src/test/resources/fixtures`).

The fake server is an `HttpTransport` that:

- is configured with tilesets (slug, collections, tiles with records), a `tilesFor` override, a `failTiles` list, a `server` base, and `goOffline()`;
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors;
- records every request (URL, method, headers, body) for the privacy tests (§12);
- validates its own traffic. There is no JVM lexicon validator; implement the contract's minimum (§13): parameter names, the `bbox` regular expression, required response fields. Keep the lexicon JSON vendored regardless, with `SOURCE` naming the garganorn commit, so that a validator can be added later.

Test files map one to one onto the reference's `test/*.test.ts`, with the same `describe`/`it` names turned into nested classes and `@Test` names, so that a reviewer can diff coverage by eye. The fixture tests are `@TestFactory` dynamic tests, one per case, so a failure names the case.

An end-to-end main against a local garganorn (`ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION`, `ATGEO_REGION`, the same variables as `scripts/e2e.ts`) lives under `src/e2e/` as a separate source set and is not part of `gradle test`.

CI: GitHub Actions on `ubuntu-latest`, `gradle test` on JDK 17 and JDK 21 with the Gradle wrapper, plus a `gradle :android-sample:assembleDebug` job to prove the artifact resolves and compiles from an Android module. No emulator in CI for the first release.

## 8. Decisions and open questions

| Decision | Choice | Why |
|---|---|---|
| Module type | plain Kotlin/JVM | no Android API used; one artifact for JVM and Android |
| Place representation | `JsonObject` | untouched JSON, structural equality, no extra type |
| Importance type | `Long` | lexicon integer with no range |
| Default transport | `HttpURLConnection`, caching off | zero dependencies; contract's no-persistence default |
| Argument errors | `IllegalArgumentException` | Kotlin convention; keeps `AtgeoException.code` the server's namespace |
| Cache lock | coroutine `Mutex` | never blocks a dispatcher thread |
| Beta distribution | JitPack by commit | free, no publishing step, pins like the JS client |

Open:

1. Whether to go Multiplatform (`jvm` + `android` + `iosArm64`) from the start instead of after. It would let one codebase serve iOS too, which argues against writing the Swift port at all. The counter-argument is that iOS developers expect a SwiftPM package with Swift types, and a KMP framework gives them Objective-C-shaped ones. Proposed: JVM first, keep the seams (section 1), decide with a real iOS consumer in hand.
2. `@JvmOverloads` and a `CompletableFuture` facade for Java callers. Not until someone asks.
3. The default cache budget on Android. The contract keeps 50 MiB (§15). Expose the option, keep the default, revisit with numbers from a device.
