# Kotlin SDK design evaluation and implementation plan

Evaluated: `docs/kotlin-sdk-spec.md` and `docs/port-contract.md` at atgeo-sdk-js `9d83e6c` (main, PR #11 "review and harden the port contract and the Swift and Kotlin specs"), against the reference source (`src/`, last behavioural change `9bfc2e0`), the test suite and the fixtures. The first evaluation was against `ae773d5`; section A below reviews what changed between the two. The target repository `schuyler/atgeo-sdk-kotlin` is empty (no branches, no issues).

## Verdict

Ready to implement. The revision is a clear improvement: it turns the contract from "mirror the reference" into "be tolerant, and here is exactly how", lists the reference's own crashes as behaviour not to copy (§16), and resolves six of the first-round items. The recipes that were actually run (normalize, Jaro-Winkler, snapping and bbox formatting, distances, importance range, URL encoding) check out on a JVM. Two claims that were not run turned out to be wrong when an independent reviewer tested them (section E: `disconnect()` does not unblock a body read on the JDK, and a fully cached call from a cancelled coroutine cannot complete normally in this design); both are corrected in the amendments on branch `docs/kotlin-spec-implementation-prep`. The three items left open after the revision are folded into the same amendments.

## A. Review of the revision (`ae773d5` → `9d83e6c`)

### Resolved from the first evaluation

| First-round finding | Status in `9d83e6c` |
|---|---|
| `URLEncoder.encode(String, Charset)` is Android API 33 | Fixed: spec now names the `"UTF-8"` overload and says why |
| Tile loop must check the search's own cancellation, not catch-all-but-`CancellationException` | Fixed, and improved: `ensureActive()` in the catch, with the `TimeoutCancellationException` argument for why the other rule is wrong |
| `byImportance` by `Long` subtraction overflows; `byOrigin` needs nulls last | Fixed: `compareValues`, `nullsLast(naturalOrder())`, with the note that no fixture pins the null case |
| Fake server cannot capture headers through a URL-only transport | Fixed: method and body fixed by construction, headers covered by the loopback transport test |
| Default transport needs its own loopback test | Fixed: five named cases, including cancellation and the null `errorStream` |
| `find()` must not touch LRU recency | Fixed: iterate entries, never `get` |

### New material, checked

- **Lenient hand-mapping of describe and tile bodies** (Kotlin §3). Correct and necessary: `kotlinx.serialization` generated serializers throw on a wrong-typed field, and the contract now forbids that. The `as? JsonPrimitive` / `isString` guards are right: `longOrNull` and `doubleOrNull` are string-content parses, so `"5"` would read as 5 without the guard. Cost: roughly 120 lines of mapping code for the describe types. A generic alternative worth considering during implementation: a 40-line sanitizer that walks a class's `SerialDescriptor` beside the `JsonObject`, drops fields whose JSON kind does not match, substitutes `[]` for required lists, and then calls the generated serializer. Same behaviour, one place to get right, but it is an implementation choice and the spec's hand-mapping is fine.
- **Importance through a double** (contract §1, Kotlin §3). Verified on JDK 21: the literal `9.223372036854775807E18` is exactly 2^63; the expression rejects ±2^63 and anything beyond, converts the largest double below 2^63 (9223372036854774784) exactly, truncates `1.9` to 1 and `-1.9` to -1, reads `9007199254740993` as 9007199254740992 (precision loss matching JavaScript, as the contract now requires), and treats `1e400` as absent.
- **`overview` truthiness** (contract §1). The rule is precise but the Kotlin spec gives no recipe, and the obvious `booleanOrNull` reads `0` and `""` as null, not false. Suggested: `JsonNull` → false; a string primitive → `content.isNotEmpty()`; a boolean → its value; a number → `doubleOrNull != 0.0` (which handles `-0`); any object or array → true.
- **`+` must be `%2B`** (contract §1). `URLEncoder` encodes a literal `+` as `%2B` and only then does the spec replace `+` with `%20`; verified on the string `g+h`. Correct.
- **Validation order** (contract §3). Region first, then the similarity check: matches the reference. `require()` calls in that order.
- **TTL boundary** (contract §10). "Fresh while `now < set + 3,600,000`" matches the reference's `Date.now() < expires`.
- **Redirects** (contract §1). `HttpURLConnection` follows same-protocol redirects by default and refuses `http` → `https`; the contract's "at least same-scheme" wording covers that.
- **Jaro-Winkler empty inner range** (contract §7). Kotlin's `for (j in lo..hi)` runs zero times when `lo > hi`, so the Swift trap does not apply; the `starbux`/`bar` case passed in the earlier run.
- **§16 reference deviations**. These are behaviours the JS suite does not test (they are crashes in the reference), so the one-to-one test mapping gains one file with no JS counterpart; see the plan.
- **CONFORMANCE.md** (contract §5). New deliverable: list the number forms the port's parser treats differently from `parseFloat`. For Kotlin's `toDoubleOrNull` (Java `Double.parseDouble` grammar behind a screening regex), verified today: accepts surrounding ASCII whitespace, `1.5f`, `1.5d` and hex floats such as `0x1p3`, which `parseFloat` does not; rejects `1e`, `1.5abc` and `1_000`, where `parseFloat` reads 1, 1.5 and 1. Both agree on `+1.5`, `.5`, `1.`, `-0`, `Infinity` and `NaN` (the last two non-finite and skipped).
- **Swift spec, in passing.** The final-sigma analysis and `Int64` change are correct and do not affect Kotlin: verified directly on JDK 21, `toLowerCase(Locale.ROOT)` turns `ΟΔΟΣ` into `οδος` with a final U+03C2, and the full recipe turns `İstanbul` into `istanbul` and `ẞ` into `ß`. The fixture covers none of these, so the contract now asks every port to test them itself; add them to `NormalizeTest`.

### Open after the revision, now folded into the spec (branch `docs/kotlin-spec-implementation-prep`)

1. **CPU work on the caller's dispatcher (high for Android).** Kotlin §5 still says normalizing and scoring run on the calling dispatcher, and the tile `async` children inherit it, so a search from `Dispatchers.Main` parses every tile's JSON on the main thread. The revision makes this slightly worse: tile records are now parsed to a `JsonElement` tree and mapped by hand, so the per-tile CPU cost is higher than a streaming decode. Proposed: `async(Dispatchers.Default)` for the children and `withContext(Dispatchers.Default)` around dedupe, filter and rank. Common Kotlin, free on the server JVM.
2. **Android API enforcement (high).** The `URLEncoder` fix addresses one instance of the class. `InputStream.readAllBytes()` is the next one waiting (also API 33), and nothing in the proposed build catches the class: the module compiles against JDK 21 with `jvmTarget = 11`, Android Lint does not run on a JVM module, and the sample's `assembleDebug` compiles fine. Proposed: animalsniffer with the `gummy-bears-api-24` signature, so any call outside Android API 24 fails `gradle build`.
3. **`android-sample` sharing the Gradle build (medium).** CI still runs `gradle :android-sample:assembleDebug` as a project of the main build, which means AGP is applied in the main build and `gradle test` needs an Android SDK for everyone. Proposed: a separate build under `android-sample/` consuming the library through `includeBuild("..")`.

Minor, also folded in: integer bbox formatting and single-pass normalization (simpler than the spec's recipes and verified equivalent), the "before the first suspension point" sentence (not an observable distinction in Kotlin), the `overview` truthiness recipe, the CONFORMANCE.md margins, and the `RobustnessTest` file. The `HttpURLConnection` cancellation text was rewritten twice: once from the first evaluation's pattern, and again after the review in section E showed that pattern's premise was wrong on the JDK.

### Licence

The JS repository at `9d83e6c` had no `LICENSE` file, no `license` field in `package.json`, and no licence statement anywhere tracked, so there was nothing for the Kotlin repository to inherit. The maintainer chose BSD-3-Clause. It is added to the JS repository on branch `chore/bsd-3-clause-license` (commit `31fea92`: the `LICENSE` file, copyright 2026 Schuyler Erle, plus the `package.json` field), and the Kotlin repository carries the identical `LICENSE` file from its first commit.

## B. Verified on a JVM (JDK 21, Kotlin 2.2.20, Gradle 8.14.3, Linux)

| Check | Result |
|---|---|
| `normalize` recipe (spec §6) and a single-pass variant vs `fixtures/normalize.json` | 30/30 on JDK 21, in Java and in Kotlin 2.2.20 |
| Jaro-Winkler transcription vs `fixtures/jaro-winkler.json`, plus symmetry and the emoji code-unit example | 33/33, within 5e-7 |
| Snapping, circle box and antimeridian split vs the contract §3 table, the extra cases in `region.test.ts`, and the 93-point grid test | all match, with both `String.format(Locale.ROOT, "%.2f")` and integer formatting |
| `distanceTo` and `haversine` vs the contract §6 table | all within 1e-6 relative; the three haversine examples are bit-identical to V8 |
| Importance range expression (Kotlin §3, revised) | rejects ±2^63 and beyond, exact below, truncates toward zero, 2^53+1 loses precision as in JS |
| `Math.round(-0.0 * 100)` | `0L`, so a `Long` units value has no negative-zero case |
| `URLEncoder.encode(v, "UTF-8").replace("+", "%20")` | `a%2Cb%3Ac%20d%26e%3Df%23g%2Bh%25i%7Ej*k%2Fl`: form encoding, literal `+` as `%2B` |
| `listOf(...).sorted()` on tile URLs | code-unit order (`https://A < https://a < https://a/10 < https://a/9`) |
| `fun interface HttpTransport { suspend fun get(url: String) }` | SAM conversion from a lambda works |
| `kotlinx.serialization` `JsonObject` decode | key order kept, unknown keys ignored, number lexeme `2.50` kept verbatim |
| Gradle 8.14.3 + Kotlin 2.2.20 + coroutines 1.10.2 + serialization 1.9.0 + `kotlin.test` on JUnit 5 | resolves and `gradle test` passes in 1m22s |
| Android SDK | not present in the environment used; `android-sample` was not built |

Current stable versions on Maven Central (2026-10-22): Kotlin 2.4.21 (2.5.0 is in beta), kotlinx-coroutines 1.11.0, kotlinx-serialization 1.12.0, JUnit Jupiter 5.14.4 (6.x needs Java 17 at runtime and does not pair with `kotlin-test-junit5`), Gradle 9.8.2 (needs JDK 17 to run; the library still targets 11), AGP 9.x, animalsniffer Gradle plugin 2.0.1, `gummy-bears-api-24` 0.16.0.

## C. Implementation plan

Library: about 900 lines of Kotlin (the lenient mapping adds to the first estimate). Tests: about 2200 lines including the fake server. Each phase ends green.

**Phase 0, scaffold.** `settings.gradle.kts`, `build.gradle.kts` with a version catalog, Gradle 9 wrapper, `jvmTarget = 11`, animalsniffer + gummy-bears API 24, `maven-publish`, `jitpack.yml`, `.gitignore`, CI workflow (JDK 17 and 21 matrix, `gradle/actions/wrapper-validation`, a separate `android-sample` job), `src/test/resources/fixtures/` vendored with `SOURCE` pinned to `9d83e6c`, README stub, `CONFORMANCE.md` stub, `LICENSE` (BSD-3-Clause, identical to the JS repository's).

**Phase 1, pure functions, no I/O.** `Text.kt` (normalize, jaroWinkler, textScore) with `NormalizeTest` (fixture plus the three case-mapping cases) and `SimilarityTest`. `Region.kt` (validate, center, circleBox, snapSpan, queryBboxes, lonSegments) with the contract §3 table as unit tests. `Locations.kt` (locate, distanceTo, inRegion) with `DistanceTest`. `Rank.kt` with unit tests for the comparators and the contract's scoring examples (§7, §8); the 12 ranking scenarios run in phase 4 through the client and the fake, as the reference does.

**Phase 2, JSON mapping and caches.** `Wire.kt`: lenient readers for tile payloads, `getTiles`, `getPlace` and the describe types, including `truthy()`, `importanceOf()` and the string/number guards, with direct unit tests from §1 and §16. `Cache.kt`: `TileCache` and `TtlCache` with direct unit tests (multi-entry eviction by one large insert, replacement subtracting the old size, `find` lowest-URL rule without recency change, expiry at exactly 3,600,000 ms).

**Phase 3, transport.** `Transport.kt`: `HttpTransport`, `HttpResponse`, XRPC URL building, `AtgeoException` parsing (each of `error` and `message` judged on its own), `HttpUrlConnectionTransport` returning an `HttpResponse` for every status (it never throws `AtgeoException`; the XRPC and tile layer does), with the caller suspended in `suspendCancellableCoroutine` and the blocking work handed to `Dispatchers.IO.asExecutor()`, the connection published to an `AtomicReference` for the cancellation handler. `HttpUrlConnectionTransportTest` on a local `com.sun.net.httpserver.HttpServer`: JSON and empty 4xx bodies (status and bytes), same-scheme redirect, cancellation mid-body asserting prompt return of the suspend function (not socket closure, which the JDK does not deliver), header names fixed across requests.

**Phase 4, client and fake server.** `AtgeoClient.kt` pipeline: 8 worker coroutines over an index counter on the injected `computeDispatcher` (default `Dispatchers.Default`), lazy cache check per URL, per-URL result slots with `fetched` and `failed` derived from them, dedupe/filter/rank under `withContext(computeDispatcher)`. `FakeServer.kt` as an `HttpTransport` with tilesets (records as `JsonObject`s), `tilesFor`, `failTiles`, `server`, `goOffline()`, a raw `responses` override by URL, URL capture, construction-time validation (string slug, object value with string name, integral importance) and the request checks the spec lists (parameter names, bbox regex, `uri` scheme). Port `client`, `transport`, `cache`, `privacy`, `overview`, `region`, `merge`, `ranking` and `fakeServer` tests one to one, keeping the `describe`/`it` names, omitting the two source-scan suites in `client.test.ts`. Every client in the suite is constructed with `computeDispatcher = StandardTestDispatcher(testScheduler)`. Add `RobustnessTest.kt`, one of the three files without a JS counterpart (with `WireTest.kt` and the transport test), covering §16: `{}` and `[]` `getTiles` bodies raise `SerializationException` and cache nothing; non-string tile entries skipped; non-object records and `null` locations or variants skipped with the tile still used; non-string `uri`, non-number `importance`, array coordinates and non-string `error`/`message` treated as absent; a `getPlace` body with no object `record` raises.

**Phase 5, extras.** `src/e2e/` source set with a `JavaExec` task reading `ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION`, `ATGEO_REGION`. `android-sample/` as a composite build with the copy-paste `OkHttpTransport`. `CONFORMANCE.md` with the number-parsing margins above. README in the house style.

**Spec amendments.** The three open items plus the `truthy()` recipe and the `RobustnessTest` note, as one small PR to `docs/kotlin-sdk-spec.md`.

## D. Open decisions for the maintainer

1. Licence: decided, BSD-3-Clause (branch `chore/bsd-3-clause-license`).
2. Spec amendments: applied on branch `docs/kotlin-spec-implementation-prep`, revised per section E; awaiting review and merge.
3. Go-ahead for phase 0 scaffolding of `atgeo-sdk-kotlin`.

## E. Independent review of this writeup and the amendments

A reviewer with no prior context read the evaluation and the spec diff, and tested claims by running code (a loopback `HttpURLConnection` probe on JDK 21, a Gradle probe with animalsniffer and the spec's recipes verbatim, the gummy-bears signature files, the Android reference pages, and the registries for the version table). Findings and what was done about each:

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | High | `disconnect()` does not unblock an in-progress body read on the JDK (confirmed: 8 s body trickle ran to completion after `disconnect()` at 500 ms; only the header wait aborts). The spec's transport paragraph asserted otherwise and its loopback test would have failed. | Transport paragraph rewritten to say what the JDK delivers: the coroutine returns promptly, the `Dispatchers.IO` thread may stay busy up to the read timeout, OkHttp is the fix for wire-level teardown. Loopback test now asserts prompt return, not socket closure. |
| 2 | Medium | "A fully cached call completes normally" is false: `coroutineScope` and `withContext` complete exceptionally under a cancelled parent even when the body returns a value. The contract allows either (§14). | Cancellation paragraph rewritten; tests must not assert either outcome. |
| 3 | Medium | "Every new recipe checks out" overstated what had been run. | Verdict narrowed to the recipes that were run; the reviewer additionally confirmed the truthiness recipe, the whitespace set expression, the three case-mapping cases and the animalsniffer check. |
| 4 | Medium | `async` + `Semaphore(8)` does not acquire permits in launch order on a multi-threaded dispatcher, so wire order was unspecified and a request-order test would be flaky. | Switched to the reference's shape: 8 workers over an index counter. Deterministic wire order, bounded coroutines. |
| 5 | Low | "JDK 8 API surface" is the wrong rule: `java.time` is Java 8 and Android API 26. | Rule restated as "whatever the API 24 signature accepts"; the tool is the rule. |
| 6 | Low | Checking the cache up front changes LRU touch order relative to the reference's lazy check; untested but a divergence. | The worker design checks the cache lazily per URL, as the reference does. |
| 7 | Low | Stale wording: no `Dispatchers.IO` block after the amendment; "read the body before the status" is impossible with `HttpURLConnection` (`responseCode` selects the stream); the `invokeOnCancellation` registration raced connection creation. | All three fixed in the rewritten transport paragraph. |
| 8 | Low | Arithmetic: the resolved table had six rows, the text said four. | Fixed. |
| 9 | Low | `parseToJsonElement` accepts unquoted literals (`1.5f`, `yes`) that `JSON.parse` rejects; affects `overview` truthiness. | Truthiness recipe made total (`booleanOrNull ?: doubleOrNull?.let { it != 0.0 } ?: true`); noted for CONFORMANCE.md. |
| 10 | Low | The ports' range check excludes exactly -2^63, which the contract's wording included. | Contract wording changed to "magnitude 2^63 or more", matching both ports. |

### Second review: consistency and completeness

A second reviewer read the amended spec against the contract, the reference, the tests, the Swift spec and this plan, looking only for what would confound implementation. Seventeen findings, all applied in commit `03e5f3d` on the same branch:

- **High.** The rewritten transport paragraph described two incompatible designs (blocking read inside the `suspendCancellableCoroutine` block on the caller's thread, which cannot return promptly, alongside "the caller is released at once"). Resolved in favour of the hand-off design: caller suspended, work on `Dispatchers.IO.asExecutor()`, connection published through an `AtomicReference`, `isCancelled` checked after publication.
- **High.** The spec had the default transport raising `AtgeoException` on a non-2xx, which would have meant the fake server's 400s never became one and every typed-error test failed. The conversion now lives above the `HttpTransport` seam, in the XRPC and tile layer; the transport returns `HttpResponse` for every status.
- **High.** `RobustnessTest` had no way to serve §16's malformed bodies through a self-validating fake. The fake gains a raw `responses` override by URL and takes records as `JsonObject`s.
- **Medium.** `FakeServerTest` could not match `fakeServer.test.ts` with the stated "contract minimum"; the fake's construction-time and request validation is now spelled out, including the `uri` scheme check. `RankingTest`'s route is pinned to the reference's (client plus fake) and the fixture's region and sort encoding is described. The two `import.meta.glob` source-scan suites are explicitly not ported. `Wire.kt` and `WireTest.kt` are in the layout. The worker design now specifies per-URL slots and derives `fetched` and `failed` from them, removing a data race a literal port of `failed++` would have had.
- **Low.** Header assertions loosened to names and invariance across requests; two `SOURCE` files distinguished; "common Kotlin" claim softened; `kotlin.math.round` (half to even) warned against; eviction through the iterator; `Long` describe fields given a conversion rule; contract wording relaxed on cache touch order and on what the fake must capture; "deterministic wire order" reworded to "URLs claimed in order".

A duplicate run of the second review (launched when the first appeared stalled) reported against the pre-fix commit and overlapped on everything above. Its additional items, applied in commit `1c9270d`: the fake's request list and offline flag must be locked, and the ported suite constructs every client with the `runTest` scheduler's dispatcher, which also keeps the two-`getTiles` order assertion in `region.test.ts` valid; `getPlace`'s cache scan runs on `computeDispatcher`; `recordKey` and `dedupe` are placed in `Locations.kt`; `Region` classes have no `init` validation; `List<String>` and list-of-object element rules and `extent`; the app-facing `name` example no longer uses `.jsonPrimitive`; `tilesFor` is a sealed type; the worked-example tables live in `RegionTest` and `DistanceTest`; `CONFORMANCE.md` is in the layout; the TTL clock is stated to be separate from virtual time.

Reviewer's verdicts on the design choices (first review): `Dispatchers.Default` inside the library sound, with the pushback to inject it (adopted as `computeDispatcher`); animalsniffer + gummy-bears sound and verified (it flagged exactly `readAllBytes()`, `URLEncoder.encode(String, Charset)` and `String.isBlank()`, with no false positives from Kotlin's `invokedynamic` codegen at `jvmTarget 11`); the composite build sound, with the note to keep one Kotlin Gradle plugin version across both builds; integer bbox formatting and single-pass normalize sound and verified verbatim; `Mutex` sound either way once the fast-path argument was dropped.
