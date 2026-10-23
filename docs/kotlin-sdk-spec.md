# Kotlin SDK specification

A Kotlin port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the library, its public API, and the decisions that are specific to Kotlin and the JVM. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: implemented in [schuyler/atgeo-sdk-kotlin](https://github.com/schuyler/atgeo-sdk-kotlin) (PR #1), which follows this document. Building it found three places where this text was wrong about the JDK or about coroutines, corrected below: the cancellation handler (section 4), the extra headers `useCaches = false` brings (section 4), and what the `withTimeout` trap actually does in the worker design (section 5). A review after it merged changed four more, in the port's `review-fixes` branch and below: the default transport asks for gzip (section 4), a transport's own timeout outside the tile loop becomes `SocketTimeoutException` (section 3, Errors), the tile loop catches `Exception` rather than `Throwable` (section 5), and `TtlCache` prunes expired entries (section 6). Later, contract §12 item 5 made the default transport send a fixed `User-Agent` (section 4; atgeo-sdk-kotlin#10). The port's `CONFORMANCE.md` lists where it reads malformed input differently from the reference. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Kotlin: `suspend` functions, structured concurrency, coroutine cancellation, immutable data classes, no checked-exception ceremony.
- Android and plain JVM from one artifact, with the smallest dependency footprint that gets there: `kotlinx-coroutines-core` and `kotlinx-serialization-json`, and nothing for HTTP by default.

Non-goals for the first release: persistence, Kotlin Multiplatform targets, a Compose layer, Java-friendly overloads (`@JvmOverloads` can come later; Java callers get the suspend functions through a `CompletableFuture` adapter if anyone asks).

The design keeps the Multiplatform door open: the public API uses only Kotlin stdlib, coroutines and `kotlinx.serialization` types, and the JVM-only pieces sit behind internal `expect`-shaped seams: `java.text.Normalizer` and `Character.getType(int)` for normalization (`Char.category` would do for the BMP, but nonspacing marks such as the variation selectors U+E0100 to U+E01EF are supplementary and need the code-point form), and the default `HttpURLConnection` transport with its `URLEncoder`. The remaining JVM uses (`AtomicInteger`, the access-ordered `LinkedHashMap`, `java.lang.Math.round`, `System.currentTimeMillis`) are local and easy to replace; bbox formatting (section 6) needs none of them. Going Multiplatform later means supplying those seams for other targets, not redesigning.

## 2. Artifact

Repository: `schuyler/atgeo-sdk-kotlin` (assumed; rename at will). Gradle project with one module, group `org.atgeo`, artifact `atgeo-client`, package `org.atgeo.client`.

```
build.gradle.kts
src/main/kotlin/org/atgeo/client/
  AtgeoClient.kt        the client; search pipeline (contract §4)
  Region.kt             Region, validation, centre, circle box, snapping (§3)
  Locations.kt          locate, PlaceLocation, distanceTo, inRegion, recordKey, dedupe (§4.6, §5, §6); the collection prefix filter (§4.7) is a line in AtgeoClient.kt
  Text.kt               normalize, jaroWinkler, textScore (§7)
  Rank.kt               hit construction and comparators (§8)
  Cache.kt              TileCache (LRU of tile bodies), ParsedTiles and TtlCache (§10)
  Transport.kt          HttpTransport, HttpUrlConnectionTransport, XRPC URL building, AtgeoException, AtgeoDecodingException (§1)
  Wire.kt               lenient readers from JsonElement: tile payloads, getTiles, getPlace, the describe types (§1, §16)
  Types.kt              SearchResult, SearchHit, PlaceRecord, ServiceDescription, Tileset, …
src/test/kotlin/org/atgeo/client/
  FakeServer.kt         request-capturing HttpTransport (§13)
  *Test.kt              one file per reference test file, plus WireTest, RobustnessTest and HttpUrlConnectionTransportTest (section 7)
src/test/resources/fixtures/
  *.json, SOURCE        vendored from atgeo-sdk-js fixtures/; SOURCE names the atgeo-sdk-js commit
  lexicon/              vendored from atgeo-sdk-js test/lexicon/ as is, including its SOURCE, which names the garganorn commit
CONFORMANCE.md          where the port reads input differently from the reference: the number-parsing margins the contract asks each port to list (§5), unquoted JSON literals, the JDK's final sigma and NaN ordering (section 6 below)
```

Toolchain: Kotlin 2.x (2.4 at the time of writing), JVM target 11 (the floor that keeps server-side JVM users happy without desugaring), Android `minSdk` 24 and `compileSdk` current; Gradle 9 through the wrapper. The library is a plain Kotlin/JVM module, not an Android library: it touches no Android API, so it needs no `AndroidManifest`, no resources and no AGP, and one artifact serves both.

Being a JVM module cuts both ways. The code compiles against the JDK's class library, so a call to a method Android gained after API 24 (`InputStream.readAllBytes()` and `URLEncoder.encode(String, Charset)` are both API 33) compiles, passes every test, and throws `NoSuchMethodError` on a device; neither the Kotlin compiler nor Android Lint, which does not run on a JVM module, can see it. The rule is therefore whatever the Android API 24 signature accepts, plus the Kotlin stdlib, in `src/main`. That is not the JDK 8 surface (`java.time` is Java 8 and Android API 26), so the tool is the rule, enforced by the animalsniffer Gradle plugin (`ru.vyarus.animalsniffer`) checking against the `com.toasttab.android:gummy-bears-api-24` signature, so that such a call fails `gradle build`. Where the stdlib has an equivalent (`readBytes()` for `readAllBytes()`), use it.

An `android-sample/` app proves the artifact runs on a device and is where the OkHttp adapter lives as an example. It is its own Gradle build, not a subproject of the library's: it consumes the library through `includeBuild("..")`, so AGP is never applied in the library build and `gradle test` needs no Android SDK. CI builds it as a separate step (section 7).

Dependencies: `org.jetbrains.kotlinx:kotlinx-coroutines-core`, `org.jetbrains.kotlinx:kotlinx-serialization-json`. Nothing else at runtime. Test scope: `kotlin-test-junit5`, `junit-jupiter` declared directly (the `@TestFactory` and `@Nested` annotations are JUnit Jupiter's, which `kotlin-test` alone does not expose), and `kotlinx-coroutines-test`.

Distribution during beta mirrors the JS client: not on Maven Central. Options, cheapest first: JitPack (free for public repos, resolves `com.github.schuyler:atgeo-sdk-kotlin:<commit>` with no publishing step), a Gradle `includeBuild` of a checkout, or GitHub Packages (needs a token even to read). Pin a full commit, as the JS README says; the API is still moving. Publish to Maven Central under `org.atgeo` once the wire contract settles.

## 3. Public API

Names match the JS client where Kotlin convention allows. `getPlace` stays `getPlace` (Kotlin has no objection to the verb, and it is what the XRPC query is called).

```kotlin
class AtgeoClient(
    server: String = DEFAULT_SERVER,
    transport: HttpTransport = HttpUrlConnectionTransport(),
    cacheBudgetBytes: Long = DEFAULT_CACHE_BUDGET_BYTES,
    computeDispatcher: CoroutineDispatcher = Dispatchers.Default,   // where tiles are parsed and results ranked (section 5)
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
    /** Radius in metres. Neither class validates in `init`: `Circle(Double.NaN, 0.0, 10.0)` constructs, and `searchPlaces` rejects it (Errors, below). */
    data class Circle(val lat: Double, val lon: Double, val radius: Double) : Region
    /** Degrees. minLon > maxLon crosses the antimeridian. */
    data class Bbox(val minLon: Double, val minLat: Double, val maxLon: Double, val maxLat: Double) : Region
}

enum class SortMode { FUSED, DISTANCE, SIMILARITY }

// Plain classes with internal constructors, not data classes (below).
class SearchResult internal constructor(
    val places: List<SearchHit>,
    val complete: Boolean,
    val overview: Boolean,
    val tiles: TileCounts,
) { class TileCounts internal constructor(val fetched: Int, val failed: Int) }

class SearchHit internal constructor(
    val origin: String?,
    val place: JsonObject,
    val importance: Long?,
    val distance: Double,      // metres
    val score: Double?,        // 0..1, null without text
) {
    val name: String?          // computed: place["name"].stringOrNull()
    val location: PlaceLocation  // computed: locate(place), section 6
}

class PlaceRecord internal constructor(val origin: String, val place: JsonObject, val importance: Long?) {
    val name: String?
    val location: PlaceLocation
}

class PlaceLocation internal constructor(val point: Point?, val bbox: Box?) {
    data class Point(val lat: Double, val lon: Double)
    data class Box(val south: Double, val west: Double, val north: Double, val east: Double)  // west > east crosses ±180
}

fun JsonElement?.stringOrNull(): String?   // the string a JSON string holds; null for anything else

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

The result and describe types are plain classes, not data classes, and their constructors are `internal`: a public data class cannot gain a field without breaking apps compiled against the version before, since its constructor, `copy()` and `componentN()` all change shape, and the results will grow (`location` was the first) while the describe types mirror lexicons that gain fields. `equals`, `hashCode` and `toString` are written to behave as a data class's would; apps get no `copy()` or destructuring and cannot construct them. The describe types below keep `@Serializable` (and are shown with their fields only; read `data class` there as `class … internal constructor`). `Region`'s classes stay data classes: apps construct them and their fields are fixed.

`importance` is `Long`, not `Int`: the lexicon says integer without a range, and the JavaScript client carries 53 bits (contract §1). `publishedAt` and the extent's edges stay strings, as served.

Every field of the describe types is nullable with a null default, and the three lists the lexicon requires (`tilesets`, and `collections` in both places) default to empty, so that a missing field never fails a call. `kotlinx.serialization` still throws on a field of the wrong type, and the contract wants that read as absent (§1), so the client does not decode a server response through these classes' generated serializers. It parses the body with `Json.parseToJsonElement` and maps the `JsonObject` by hand: a missing or wrong-typed field becomes null, a list the lexicon requires (`tilesets`, `collections`) that is missing or not an array becomes empty, an optional list becomes null, and a list element that does not map is dropped. Reach a primitive with `as? JsonPrimitive`, never `.jsonPrimitive`, which throws on an object or array (the reference does receive `uri: {}`), then check its kind before reading it: `JsonPrimitive.longOrNull` is `content.toLongOrNull()`, which reads the string primitive `"5"` as 5, so a string field is `takeIf { it.isString }?.content` and a number field is `takeUnless { it.isString }?.doubleOrNull`. A `Long` field (`recordCount`, `count`) applies the importance rule below to that double: finite and below 2^63 in magnitude, truncated toward zero, else null. In a `List<String>` (`licenses`, `locationFormats`, `containmentTypes`, `attributes`) a non-string element is dropped; in a list of objects (`tilesets`, `collections`, `categories`, `references`) a non-object element is dropped and an object with no readable field still maps, to an instance of nulls; `extent` that is not an object is null. `@Serializable` stays on the classes for apps that want to persist them.

### Place values

A place is arbitrary JSON and must be surfaced untouched (contract §1). `kotlinx.serialization.json.JsonObject` is exactly that: immutable, structurally equal, and preserving every key and nested value as served, including key order. An app reads a field with the public `JsonElement?.stringOrNull()` (`hit.place["cuisine"].stringOrNull()`), never `.jsonPrimitive`, which throws on an object or array, nor kotlinx's `contentOrNull`, which turns the number 5 into "5". `SearchHit` and `PlaceRecord` also have `name` and `location` (contract §14 allows such accessors): `location` is a `PlaceLocation` built by the same `locate()` the ranker uses, so it cannot disagree with `distance`, and it is computed on each access rather than stored, so the classes' shape does not change. `PlaceLocation` is not called `Location`, which would collide with `android.location.Location` in app code; its box keeps the lexicon's names rather than adding a third argument order next to `Region.Circle` and `Region.Bbox`. A typed `Place` class is a reasonable later addition on top of `JsonObject`, not a replacement for it.

Tile records are read from the parsed `JsonObject` into an internal `TileRecord(value: JsonObject, uri: String?, importance: Long?)`; the rest of the payload is dropped. A record that is not an object, or whose `value` is not one, is skipped and the tile stays used (contract §4.4); a `uri` that is not a string and an `importance` that is a string primitive or not a number read as null, and a non-integer importance truncates toward zero: read it as `takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() && abs(it) < 9.223372036854775807E18 }?.toLong()`, since `longOrNull` returns null for `1.9` and reads `"7"` as 7, and `Double.toLong()` saturates where the contract wants absent (§1). A `getTiles` body with no `tiles` array has no usable tile list and raises `AtgeoDecodingException` (§1); entries of `tiles` that are not strings are skipped. `overview` follows the contract's truthiness rule (§1), which no single `kotlinx.serialization` accessor gives (`booleanOrNull` reads `0` and `""` as null, not false): an absent key and `JsonNull` are false; a string primitive is `content.isNotEmpty()`; a non-string primitive is `booleanOrNull ?: doubleOrNull?.let { it != 0.0 } ?: true`, which covers `-0` and treats an unquoted literal the tree parser let through (section 6) as true; a `JsonObject` or `JsonArray` is true.

### Errors

```kotlin
/** A non-2xx answer from the server. `code` is the server's error name, or "HttpError"; `status` the HTTP status (contract §1). */
class AtgeoException(val code: String, message: String, val status: Int) : RuntimeException(message)

/** A 2xx answer the client could not use: not JSON, or without what the call needs (contract §1). */
class AtgeoDecodingException(message: String, cause: Throwable? = null) : IOException(message, cause)
```

Bad arguments (contract §3) throw `IllegalArgumentException` from `require()` calls at the top of `searchPlaces`, in the contract's order, before anything is looked up or fetched; the observable rule is that no request is made. This matches the JS client's `TypeError` in spirit: a programming error, kept out of `AtgeoException`'s code namespace.

Network failures throw `IOException` (or whatever the injected transport throws) unwrapped, with one exception: a `CancellationException` from the transport while the caller is still active (the transport's own `withTimeout`, say) is rethrown by the XRPC layer as `SocketTimeoutException` for a `TimeoutCancellationException` and as `IOException` otherwise, each with the original as its cause. Left as it is, it would end the caller's `launch {}` silently, and contract §14 calls a timeout a network failure. A 2xx body that is not JSON, or has no usable body in the contract's narrow sense (§1: no `tiles` array, no `record` object, a describe body that is not an object), throws `AtgeoDecodingException`, with kotlinx's `SerializationException` as its cause when the parser threw one; nothing else about a body's shape throws. It is the port's own type, as §1 allows, because `SerializationException` is an `IllegalArgumentException`, so a `catch` meant for a bad region would also catch a garbled answer; as an `IOException` it lands with the network failures, which is what it is to a caller: no usable answer arrived. For tiles, either counts as a failed tile. The search's own cancellation must propagate anywhere the client catches `Exception` (the tile-fetch loop and the XRPC layer are the two such places; neither catches `Throwable`, so that an `OutOfMemoryError` while parsing a tile fails the search instead of passing for one bad tile); section 5 gives the exact rule, which is not "rethrow every `CancellationException`".

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
    private val maxBodyBytes: Int = DEFAULT_MAX_BODY_BYTES,   // 32 MiB
) : HttpTransport
```

The default transport uses `java.net.HttpURLConnection` because it is on every JVM and every Android version with no dependency, which is the cost-conscious default. It is blocking, so the design question is who waits. The transport suspends the caller in `suspendCancellableCoroutine` and hands the blocking work to `Dispatchers.IO.asExecutor()`; the coroutine does not wait for that thread. The handler, registered before the task is submitted, hands `disconnect()` to the same executor: `invokeOnCancellation { connectionRef.get()?.let { c -> io.execute { c.disconnect() } } }`, with `io` being `Dispatchers.IO.asExecutor()`. It must not call `disconnect()` inline: a cancellation handler has to be fast and non-blocking, and on the JDK `disconnect()` can block its caller until a body read in progress finishes (next paragraph). The task opens the connection, publishes it to that `AtomicReference`, checks `cont.isCancelled` once after publishing (and disconnects and stops if so, which closes the window between registration and publication), performs the request, and calls `cont.resume` or `cont.resumeWithException`. A resume after cancellation is ignored, so the caller gets `CancellationException` promptly whatever the socket is doing. Running the blocking read inside the `suspendCancellableCoroutine` block on the caller's own thread would not do: the coroutine does not suspend until that block returns, so the caller would wait out the read.

What `disconnect()` does to the socket is the platform's business, and on the JDK it is less than the name suggests. Verified on JDK 21 against a loopback server: `disconnect()` aborts a connection still waiting for response headers (`SocketException` within a few milliseconds), but does not unblock a read that is already consuming the body, which runs on until the server finishes or `readTimeoutMillis` elapses; thread interruption does nothing either. Worse, `disconnect()` itself blocks until that read ends: in a probe it returned after 2.7 seconds, when the server finished the body, and a transport that called it from the cancellation handler kept the cancelling thread waiting for 9.8 seconds in the loopback test. Hence the hand-off above. So on the JDK a cancelled tile fetch frees the caller at once, but the executor thread stays busy until the body finishes or the read timeout fires, and the bytes it reads are discarded. The cost is up to 8 `Dispatchers.IO` threads (of 64) per cancelled search for up to `readTimeoutMillis`, which is why the default read timeout stays at 30 seconds rather than higher and why it is a constructor parameter. Android's `HttpURLConnection` is OkHttp underneath and is expected to close the socket on `disconnect()`, but that is untested here; an app that cancels searches often, a search per keystroke for instance, should pass the `OkHttpTransport` below, which tears requests down on the wire.

The transport returns an `HttpResponse` for every status and never throws `AtgeoException`. It sets `useCaches = false`, which makes the JDK add `Pragma: no-cache` and `Cache-Control: no-cache` to every request (fixed values, so the privacy argument is unaffected); sends `Accept: application/json`, `Accept-Encoding: gzip` and `User-Agent: atgeo-client-kotlin` (contract §12, item 5), and no `Accept-Language`; calls `responseCode`, which is what selects `inputStream` for a 2xx and `errorStream` otherwise (`getInputStream()` throws `FileNotFoundException` on a 404, and `errorStream` is null for an empty error body, which reads as empty); and reads the chosen stream to its end, decoding it with `GZIPInputStream` when `Content-Encoding` is `gzip` and the body is not empty. Both reads go through a bounded reader that throws `IOException` as soon as more than `maxBodyBytes` has arrived (contract §14): the server names the tile URLs, deflate expands up to about 1000:1, and the largest tiles places.atgeo.org serves are about 2 MB. The sample's `OkHttpTransport` applies the same cap with Okio's `request(maxBodyBytes + 1L)`. The JDK never asks for gzip on its own, and places.atgeo.org gzips only when asked: one Manchester tile is 1,272,337 bytes plain and 120,290 gzipped. Setting the header explicitly turns off the transparent decoding Android's OkHttp-backed `HttpURLConnection` would otherwise do, so the transport decodes on both platforms rather than assuming either. The tile cache still measures the decoded body. The conversion of a non-2xx into `AtgeoException` happens above the `HttpTransport` seam, in the XRPC and tile layer of `Transport.kt`, so that it applies to the fake server's responses as much as to the default transport's: the body is parsed with `runCatching { Json.parseToJsonElement(body.decodeToString()) }.getOrNull() as? JsonObject`, `error` and `message` are each read with the string-primitive guard of section 3, and anything missing falls back to `HttpError` and `HTTP {status}` (contract §1, §16). The body is always in hand before the status is judged.

The timeouts are a freedom the contract grants (§14): the reference gives each request 30 seconds in all, body included (`requestTimeoutMs`), where this transport times out a connection after 10 seconds and a stalled read after 30; either way a tile that times out is a failed tile.

`HttpURLConnection` on Android has no HTTP/2 and a dated TLS stack on old devices. Apps that already ship OkHttp should pass a ten-line `OkHttpTransport`, which the `android-sample/` module provides as copy-paste code rather than as a dependency of the library. Any transport an app supplies must disable its own response cache or accept that the contract's no-persistence default (§10, §14) no longer holds.

XRPC URLs are built by percent-encoding each query value with `java.net.URLEncoder.encode(value, "UTF-8")` (the `Charset` overload is Java 10 and Android API 33, above `minSdk`; the API check in section 2 catches this class of mistake) and then replacing `+` with `%20`. That is form encoding (`,` → `%2C`, `:` → `%3A`) with spaces as `%20`; the contract allows either (§1). Never build query strings by string template without encoding.

The tile cache measures a tile as `body.size` bytes (§10).

## 5. Concurrency and cancellation

- `searchPlaces` runs inside `coroutineScope`. The two `getTiles` calls for an antimeridian-crossing region are `async` siblings; if one throws, structured concurrency cancels the other and the search fails with the first error (allowed, §14).
- Tiles are fetched by `min(8, urls.size)` worker coroutines started with `launch(computeDispatcher)`, each taking the next index from a shared `AtomicInteger` and writing its result into that index's slot: the reference's `mapLimit`. URLs are claimed in order with at most 8 in flight (the first calls can still interleave on a multi-threaded dispatcher; nothing in the suite asserts request order), and completion order never affects results (§4.3). `async` children behind a `Semaphore(8)` look equivalent but are not: on a multi-threaded dispatcher, permits are not acquired in launch order (a probe observed `0..6, 8, 7, 9, 11, 10`), so a test asserting request order would be flaky, and one coroutine per tile up front is heavier for a large region. Each worker catches `Exception` around one tile, calls `coroutineContext.ensureActive()` inside the catch so that its own cancellation propagates, and otherwise leaves the slot null. The slots are an `arrayOfNulls<TileOutcome>(urls.size)`, a sealed type: `Used` holds a used tile's cache entry and its records (an empty list for a tile whose every record was skipped), `Failed` holds its `TileFailure` (contract §4.4). The entry goes with the records so that the search can hand both to `ParsedTiles` when it ends (section 6). After the workers' `coroutineScope` returns, `fetched` is the count of `Used` slots and `tileFailures` the `Failed` ones in slot order, which is URL order, so `failed` is its size, so no counter is shared between threads (the reference's `failed++` would be a data race here). Catching everything but `CancellationException` is not the same rule: a transport that uses `withTimeout` throws `TimeoutCancellationException`, which is a `CancellationException`. In this worker design rethrowing it does not fail the search, because a `launch` child that completes with a `CancellationException` ends without failing its parent; the worker just stops, and the others go on claiming URLs. The damage is quieter: when every worker hits a timeout at once, the URLs after them are never claimed, and they are counted as failed without ever being requested. A test for this needs more timeouts than workers (8 timing-out tiles and a ninth that answers); with fewer, both rules give the same counts. The reference's check is `signal.aborted`, the search's own cancellation and nothing else.
- A worker checks the tile cache under the mutex when it reaches a URL, as the reference does, so a cached tile never becomes a request and recency is touched in the same order as in the reference. Writes happen under the mutex as tiles arrive. The mutex is never held across a transport call.
- Nothing blocks a dispatcher thread except the default transport's request task, which runs on `Dispatchers.IO` threads (section 4). The CPU work does not run on the caller's dispatcher either: the workers run on `computeDispatcher`, so a tile body is parsed and mapped off the calling thread, and dedupe, filtering, scoring and ranking run inside `withContext(computeDispatcher)`. `computeDispatcher` is a constructor parameter defaulting to `Dispatchers.Default`, following the Android convention of injecting dispatchers. The ported test suite constructs every client with `computeDispatcher = StandardTestDispatcher(testScheduler)` inside `runTest`: the workers then run single-threaded on virtual time, the fake server sees one request at a time, the `determinism` test's staggered delays cost nothing, and the two `getTiles` calls of a crossing region start in order, which `region.test.ts` asserts. The TTL clock is separate from virtual time: expiry tests use the `internal` constructor's `clock` (section 6). `getPlace`'s cache scan (section 6) also runs inside `withContext(computeDispatcher)`, since it walks every cached tile's keys and may parse the tile that holds the match. The reason is Android: an app searches from `Dispatchers.Main`, and child coroutines otherwise inherit that context, which would put megabytes of JSON parsing and tens of thousands of Jaro-Winkler comparisons on the main thread. On a server JVM the switch costs a dispatch and nothing else. `Dispatchers.Default` is common Kotlin, so the Multiplatform door stays open.

Cancellation: cancelling the calling coroutine stops the search promptly and it throws `CancellationException`; whether the in-flight requests are torn down on the wire is the transport's business (section 4). A fully cached call from an already-cancelled coroutine also throws `CancellationException`: `coroutineScope` and `withContext` complete exceptionally when their parent is cancelled even if the body returns a value, so this design cannot complete such a call normally, and the contract does not ask it to (§14 lists it as a freedom). Tests must not assert either outcome. Do not add `ensureActive()` at the top of `searchPlaces`; the scope already does that work.

## 6. Implementing the contract in Kotlin

Pointers for the parts where the JVM's defaults would give the wrong answer. Everything else is a direct transcription of the reference.

### Normalization (contract §7)

Verified against all 41 fixture cases on a JVM (JDK 21; Kotlin 2.2 when written, 2.4 in the port):

```kotlin
private val WHITESPACE: Set<Int> = (
    listOf(0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680) +
    (0x2000..0x200A) + listOf(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
).toSet()

fun normalize(s: String): String {
    val folded = Normalizer.normalize(s.lowercase(), Normalizer.Form.NFKD).lowercase()   // 1. lowercase, 2. NFKD, 3. lowercase
    val out = StringBuilder(folded.length)
    var pendingSpace = false
    var i = 0
    while (i < folded.length) {
        val cp = folded.codePointAt(i)
        i += Character.charCount(cp)
        if (Character.getType(cp) == Character.NON_SPACING_MARK.toInt()) continue   // 4. drop Mn
        if (cp in WHITESPACE) { pendingSpace = out.isNotEmpty(); continue }          // 5. collapse and trim
        if (pendingSpace) { out.append(' '); pendingSpace = false }
        out.appendCodePoint(cp)
    }
    return out.toString()
}
```

The second `lowercase()` is contract step 3: it catches the capitals NFKD makes from characters with no lowercase of their own (`ℌ`, `𝐇`), and changes nothing on text that is already lowercase. One pass over code points does steps 4 and 5 together: a whitespace run becomes a single space only when a non-space follows it, which also trims both ends. `String.lowercase()` is `toLowerCase(Locale.ROOT)`: locale-independent full case mapping through `SpecialCasing`, so `ΟΔΟΣ` gets its final sigma, `İ` becomes `i` + U+0307 and `ẞ` becomes `ß`, the cases the contract names (§7), which the fixture now covers along with the two Greek abbreviations; JDK 21 matches V8 on all six with no extra code. The JDK decides whether a sigma is word-final by a different rule from V8's, so the two disagree where a digit or a combining mark sits next to it (`Σ1Σ`); no fixture case does that, and the port's `CONFORMANCE.md` lists the cases. Never `toLowerCase()` with the default locale, which on a Turkish device turns `I` into dotless `ı`. The whitespace set is spelled out because Java's `\s` is ASCII-only by default, `UNICODE_CHARACTER_CLASS` matches a different set (it includes U+0085 and excludes U+FEFF), and Kotlin's `trim()` with no predicate uses `Char.isWhitespace`, which trims U+001C to U+001F and keeps U+FEFF; none of them can stand in for the loop.

`java.text.Normalizer` is in Android since API 9. Unicode version skew between the JDK, Android's ICU and V8 is possible at the margins; the fixture is the arbiter, and a case that fails only on one runtime is recorded as known skew rather than worked around in the algorithm.

### Jaro-Winkler (contract §7)

Verified against all 33 fixture cases on a JVM. Kotlin strings are UTF-16, so `s[i]` and `s.length` are already code units and the reference transcribes directly; do not convert to code points. Use `BooleanArray` for the match arrays.

### Numbers and trigonometry (contract §3, §6)

- Coordinates arrive as `JsonPrimitive`. Accept a string primitive via `toDoubleOrNull()` and a numeric primitive via `doubleOrNull`; anything else, a `JsonArray` included, is no location (contract §16). `toDoubleOrNull()` accepts a few things `parseFloat` would not (hex floats, `1.5f`, surrounding ASCII whitespace) and rejects trailing text; both are within the contract's freedom (§5). Check `isFinite()` after parsing. The port's `CONFORMANCE.md` lists the margins, as §5 asks: `toDoubleOrNull()` accepts surrounding ASCII whitespace, a trailing `f` or `d`, and hex floats such as `0x1p3`, which `parseFloat` does not; it rejects `1e`, `1.5abc` and `1_000`, where `parseFloat` reads 1, 1.5 and 1. It also notes that `Json.parseToJsonElement` accepts an unquoted literal such as `1.5f` or `yes` as a non-string primitive where `JSON.parse` rejects the whole body, so a body the reference would refuse can parse here; a compliant server never sends one. A whole body that is one such token (`<html>`, `yes`) parses as a lone primitive; every reader rejects it for not being an object, so the call still fails with `AtgeoDecodingException`.
- `round3`: `Math.round(x * 1000) / 1000.0`. `Math.round(Double)` rounds half up, the same as `Math.round` in JavaScript, and returns `Long`. Use `java.lang.Math.round` here and in snapping, never `kotlin.math.round`, which rounds half to even (`round(2.5)` is `2.0`); `Double.roundToLong()` is the common-Kotlin equivalent with the same half-up rule.
- Snapping: `Math.round(x * 100)` for the epsilon test, `floor` and `ceil` from `kotlin.math`, all brought to `Long` hundredths. Format from the integer, not through a double: with `a = abs(units)`, the string is `(if (units < 0) "-" else "") + a / 100 + "." + (a % 100).toString().padStart(2, '0')`. That has no locale, no negative zero (`Math.round(-0.0 * 100)` is `0L`) and no floating point, and it is common Kotlin. `"%.2f".format(Locale.ROOT, units / 100.0)` gives the same strings on every worked example and is acceptable, but it needs the explicit locale (a German default would print `37,77`) and a guard against `-0.0`, which `%.2f` prints as `-0.00`.
- `kotlin.math.sin`, `cos`, `asin`, `atan2`, `sqrt` map to `java.lang.Math`, which may differ from V8's implementations in the last bit. Compare the worked distance tables to 1e-6 relative, containment exactly.
- The tile URL sort is `urls.sorted()`: `String.compareTo` compares UTF-16 code units, which is what the contract wants (§4.3).

### Ranking (contract §8)

`sortedWith` is stable (it is `java.util.Arrays.sort` on objects, a TimSort), but add the input index as a final `thenBy` anyway so the guarantee is in the code and not in a library contract. Build the comparator chain with `Comparator` and `thenComparing`/`thenBy` in exactly the order of the contract's table, and keep `byScore` on `round3` of the score; the usual porting mistake is to compare raw scores and lose the ties the reference has. Compare with `compareByDescending`/`compareValues`, not by subtraction: `(b.importance ?: 0) - (a.importance ?: 0)` overflows `Long` at the extremes, and the contract's comparator table describes an order, not arithmetic. One trap: `compareValues` and `thenBy { it.origin }` order nulls first, while the contract's `byOrigin` puts a null origin after every string (§8). Use `nullsLast(naturalOrder())` for that comparator; no fixture pins the null-against-string case, so the mistake would survive the suite. Comparing doubles needs one decision the reference never made: a NaN distance (only out-of-range place coordinates produce one) makes the reference's subtraction comparator inconsistent, and Java's sort may throw on an inconsistent comparator. Compare with `<` and `>`, treat `-0` and `0` as equal as subtraction does, and sort NaN after every number; `CONFORMANCE.md` records it.

### Caches (contract §10)

`TileCache` holds each tile's body as served, not its parsed records, with the keys (§4.6) of its usable records for the `getPlace` scan; a tile counts as its body size. Parsed, a tile takes 6.9 times its body size on HotSpot (JDK 21) and 5.1 times on ART (Android 14), measured on the same eight Manchester tiles, so a cache of parsed tiles against a body-size budget would hold 250 to 350 MB when the default 50 MiB is full; the key sets add 8.5%. `ParsedTiles` keeps the parsed records of the latest search's tiles, outside the budget (contract §10), so that the same region searched with new text parses nothing; re-parsing those eight tiles took 30 ms on HotSpot and 211 ms on an Android emulator. A worker uses a memoized tile only while `TileCache` still holds the same `Entry` instance, so fetching and recency are exactly as without the memo. `TileCache` is a `LinkedHashMap<String, Entry>(16, 0.75f, true)` (access order) plus a running total, with eviction done by walking an entry iterator from the eldest after each insert and removing through it (`iterator.remove()`, not `map.remove`, which would throw `ConcurrentModificationException`); `removeEldestEntry` is tempting but cannot evict more than one entry per insert, and a large tile must be able to evict several. `TtlCache` takes a `clock: () -> Long` (epoch millis); the public constructor of `AtgeoClient` passes `System::currentTimeMillis`, an `internal` constructor lets tests inject one. Its `set` drops expired entries before inserting (a freedom contract §14 grants): every distinct snapped search box is its own tile-list key, so without pruning a client shared for the life of the process grows without bound under a panning map.

`find(key)` for `getPlace` scans every cached tile's key set and returns the lowest URL holding the key, whose records (from `ParsedTiles` or parsed from the body) give the first record with that key; with a full cache that is milliseconds under the mutex, which is why `getPlace` runs it on `computeDispatcher` (section 5). Iterate the map's entries for this: iterating an access-ordered `LinkedHashMap` does not count as access, which is what §10 wants (`find` must not touch recency), and `get` would both reorder and throw `ConcurrentModificationException` mid-iteration.

## 7. Testing

Framework: `kotlin.test` over JUnit 5, with `kotlinx-coroutines-test` for `runTest`. Fixtures load from the test classpath (`src/test/resources/fixtures`).

The fake server is an `HttpTransport` that:

- is configured with tilesets (slug, collections, tiles with records given as `JsonObject`s, not as the client's `TileRecord`, so that malformed records are expressible), a `tilesFor` override returning a sealed type with the three shapes the reference's tests use (a URL list, `{tiles, overview}`, or `{error, message}`), a `failTiles` list, a `server` base, `goOffline()`, and a `responses: Map<String, HttpResponse>` override of raw responses by URL that bypasses routing and validation, which is how `RobustnessTest` serves the contract's §16 bodies (`{}` or `[1, "x"]` as a tile list, a record that is a number, a `getPlace` body without `record`, an error body with `error: 7`);
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors;
- records every request URL for the privacy tests (§12), in a list guarded by a lock along with the offline flag, since a client on `Dispatchers.Default` calls it from several threads. The `HttpTransport` seam carries a URL and nothing else: the method is always GET and there is never a body, so those are fixed by construction rather than recorded; the ported tests that assert them (`sends no body`, the GET check in `issues only getTiles and tile requests`, `overview`'s `not.toHaveProperty("summary")`) keep their names and their remaining assertions so the by-eye diff still lines up. Headers belong to the real transport and are outside the fake's view; the privacy requirement on them is met by the default transport adding only fixed headers of its own, which the transport test (below) checks against a loopback server;
- validates its own traffic. There is no JVM lexicon validator, so the fake implements the contract's minimum (§13) plus what `fakeServer.test.ts` asserts. At construction: every tileset has a string `slug`; every tile record is an object with an object `value` whose `name` is a string; an `importance`, when present, is an integral JSON number, and the failure message contains "integer". For requests: unknown parameter names and missing required ones (`dataset` and `bbox` for getTiles, `uri` for getPlace, `slug` for describeTileset) are 400 `InvalidRequest`; `bbox` must match the §13 regular expression; `uri` must look like a URI the way the lexicon's `format: uri` demands (a scheme, a colon, optional `//`, then non-space characters not starting with `/`, so `not a uri` fails and `urn:atgeo:...` and `https://...` pass). Its own responses carry the lexicon's required fields. Keep the lexicon JSON vendored regardless, with its own `SOURCE` naming the garganorn commit, so that a validator can be added later.

Test files map one to one onto the reference's `test/*.test.ts`, with the same `describe`/`it` names turned into nested classes and `@Test` names (JS-specific words such as `TypeError` and `synchronously` become `IllegalArgumentException` and "before any request"), so that a reviewer can diff coverage by eye. Two suites in `client.test.ts` are not ported: `retired wire names` and `universal runtime (R9)` scan the TypeScript source with `import.meta.glob`, and the animalsniffer check is their counterpart here. The fixture tests are `@TestFactory` dynamic tests, one per case, so a failure names the case. `RankingTest` drives each scenario the way `ranking.test.ts` does, through `AtgeoClient` and the fake with one tile at `https://places.atgeo.org/tiles/t0.json`, so the fixture values travel untouched as `JsonObject`s; the fixture's `region` is either `{lat, lon, radius}` or `{bbox: [minLon, minLat, maxLon, maxLat]}`, `sort` is a lowercase string, and the assertions are membership: each `expect.top[k].origins` within the first `k` hits, each `expect.absent` origin nowhere, and an empty `top` meaning an empty result. Three files have no reference counterpart: `WireTest.kt` for the lenient readers, `RobustnessTest.kt`, which covers the contract's §16 behaviours through the fake's raw-response override (the reference crashes on them, so the JS suite cannot test them), and `HttpUrlConnectionTransportTest.kt` (next paragraph). `NormalizeTest` adds the three case-mapping cases the contract names (§7); `RegionTest` and `DistanceTest` add the contract's worked-example tables (§3 bbox strings, §6 distances) as `@TestFactory` cases.

The default transport gets one small test of its own against a loopback HTTP server, since the fake replaces it everywhere else: a 4xx with a JSON error body and a 4xx with an empty body (both asserting the `HttpResponse` status and body bytes, since the transport does not raise `AtgeoException`; `errorStream` is null for the empty one and must read as empty), a same-scheme redirect, a gzipped body when gzip is asked for and an empty body labelled gzip, cancellation while a body is streaming (assert that the suspend function returns with `CancellationException` within a few hundred milliseconds, not that the socket closes: on the JDK it does not, section 4), and the request headers: a fixed set of names, `Accept: application/json`, `Accept-Encoding: gzip`, `User-Agent: atgeo-client-kotlin` (contract §12, item 5), no `Accept-Language`, and the same set on two different requests, since the connection headers vary by JDK and the privacy argument needs only that nothing request-dependent is added. The test runs on the JVM only; on Android the same holds by AOSP's source: its `HttpURLConnection` (OkHttp-based) uses `http.agent` only when no `User-Agent` is set, and adds no `Accept-Language`. It also checks the body cap: a body of exactly `maxBodyBytes` is read, one byte more fails with `IOException`, and so does a few-kilobyte gzip body that decodes past the cap.

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
| Cache lock | coroutine `Mutex` | common Kotlin, so it survives a Multiplatform move; the sections are short and never suspend, so a JVM lock would also do |
| CPU work | `computeDispatcher`, default `Dispatchers.Default` | Android callers search from `Main`; injectable for tests; a dispatch costs nothing on a server |
| Tile fetching | 8 workers over an index counter | the reference's `mapLimit`; URLs claimed in order, bounded coroutines |
| Android API floor | animalsniffer + `gummy-bears-api-24` | the compiler and Lint cannot see an API 33 call in a JVM module |
| Sample app | separate Gradle build via `includeBuild` | no AGP or Android SDK needed to build and test the library |
| Beta distribution | JitPack by commit | free, no publishing step, pins like the JS client |

Open:

1. Whether to go Multiplatform (`jvm` + `android` + `iosArm64`) from the start instead of after. It would let one codebase serve iOS too, which argues against writing the Swift port at all. The counter-argument is that iOS developers expect a SwiftPM package with Swift types, and a KMP framework gives them Objective-C-shaped ones. Proposed: JVM first, keep the seams (section 1), decide with a real iOS consumer in hand.
2. `@JvmOverloads` and a `CompletableFuture` facade for Java callers. Not until someone asks.
3. The default cache budget on Android. The contract keeps 50 MiB (§15). Expose the option, keep the default, revisit with numbers from a device.
4. Reporting failed tiles (contract §4.4). `SearchResult` gains `tileFailures: List<TileFailure>`; its constructor is `internal`, so callers are unaffected, and `equals`, `hashCode` and `toString` take the new field. `TileFailure` has an `internal` constructor and `url: String`, `kind: TileFailure.Kind` (`REFUSED`, `STATUS`, `DECODE`, `TRANSPORT`), `status: Int?` and `error: Throwable`, left out of `equals` and `hashCode`. The guarded region shrinks: `loadTile` catches `Exception` around the request, the status check and the decode, and a `StackOverflowError` from the decoder alone (kotlinx 1.12 reports deep nesting as a `SerializationException` anyway); building the cache entry and `tiles.set` sit outside it, and the `ensureActive()` rule stays as it is (section 5). A prerequisite, separate from this change because contract §4.4 already requires it: the port has no explicit refused-URL check. Verified with a loopback probe before the fix: a relative tile URL failed as `MalformedURLException`, a `file:` or `ftp:` URL as a `ClassCastException` from `openConnection() as HttpURLConnection`, which only the catch-all turned into a failed tile, and a URL with credentials, or an empty userinfo, was fetched. A check like the Python and Rust ports' (absolute `http` or `https`, a host, no username or password; an empty userinfo is a margin either way, contract §4.4) before the transport sees the URL fixes all three, for app transports too. No logging: nothing in the standard library serves both the JVM and Android without a dependency.
