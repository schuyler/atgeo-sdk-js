# Rust SDK specification

A Rust port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the crate, its public API, and the decisions that are specific to Rust. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: proposal. Nothing here has been built. The recipes in section 6 were run with Rust 1.97 against the fixtures at `dae7995` and the contract's worked tables, and pass: `normalize.json` 41/41, `jaro-winkler.json` 33/33 (worst distance from the fixture 4.8e-7), the contract's §3 bbox table, the exact expectations in `region.test.ts` and its 93-box grid test, the §6 distance table (bit-identical on x86_64 Linux), and the 12 ranking scenarios through a transcription of §4.6 to §4.9. The transport and concurrency claims in sections 4 and 5 were measured against a loopback server. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Rust: an async client that runs on any executor because it has none of its own and spawns nothing, and a blocking client for code without one, with the same methods and results; owned result types; one error enum; a client that is `Send + Sync` and meant to be shared.
- A small dependency tree, and nothing for HTTP unless the app asks for the default transports.

Non-goals for the first release: `wasm32` (the JS client serves browsers), persistence, `no_std`, C or UniFFI bindings, and a typed `Place` model.

## 2. Crate

Repository: `schuyler/atgeo-sdk-rust` (assumed; rename at will). Crate `atgeo`, which is unclaimed on crates.io at the time of writing.

```
Cargo.toml
src/
  lib.rs              the public names, re-exported; the README as crate docs, so its examples compile as doctests
  client.rs           AtgeoClient: the async driver (section 5)
  blocking.rs         blocking::AtgeoClient and blocking::HttpTransport (feature "blocking")
  engine.rs           the sans-I/O core both drivers share: caches, search planning, tile parsing, assembly (contract §4)
  region.rs           Region, validation, centre, circle box, snapping, bbox strings (§3)
  locations.rs        locate, distance_to, in_region, record_key, dedupe (§4.6, §5, §6)
  text.rs             normalize, jaro_winkler, text_score (§7)
  rank.rs             hit construction and comparators (§8)
  cache.rs            TileCache (LRU of tile bodies), ParsedTiles, TtlCache (§10)
  wire.rs             body decoding and the lenient readers from serde_json::Value (§1, §16)
  xrpc.rs             XRPC URL building and the status check that yields Error::Atgeo (§1)
  transport.rs        HttpResponse, HttpTransport, BoxError; ReqwestTransport (feature "reqwest")
  types.rs            SortMode, SearchOptions, SearchResult, SearchHit, PlaceRecord, PlaceLocation, the describe types
  error.rs            Error, AtgeoError, DecodingError, ArgumentError
tests/
  fixtures/           vendored from atgeo-sdk-js fixtures/; SOURCE names the atgeo-sdk-js commit
  fixtures/lexicon/   vendored from atgeo-sdk-js test/lexicon/ as is, including its SOURCE, which names the garganorn commit
  common/             the fake server (both transport traits), the loopback HTTP server, a client wrapper that runs one test body against both clients (section 7)
  *.rs                one file per reference test file, plus wire.rs, robustness.rs, concurrency.rs and transports.rs (section 7)
examples/e2e.rs       end-to-end run against a live garganorn
CONFORMANCE.md        where this port reads malformed input differently from the reference (§5, §14)
deny.toml             cargo-deny policy: permissive licences only, no known advisories
```

CRATE-TOOLCHAIN

## 3. Public API

Names follow the Rust API guidelines. `get_place` keeps the verb, as in the JS and Kotlin clients and the XRPC query it wraps; the guideline against `get_` prefixes is about field getters, not network calls.

```rust
pub struct AtgeoClient<T = ReqwestTransport> { /* transport, server, caches */ }

#[cfg(feature = "reqwest")]
impl AtgeoClient<ReqwestTransport> {
    pub fn new() -> Self;                                         // default server, ReqwestTransport::new()
}

impl<T: HttpTransport> AtgeoClient<T> {
    pub const DEFAULT_SERVER: &'static str = "https://places.atgeo.org";
    pub const DEFAULT_CACHE_BUDGET_BYTES: u64 = 50 * 1024 * 1024;

    pub fn with_transport(transport: T) -> Self;
    pub fn server(self, server: impl Into<String>) -> Self;       // trailing slashes stripped (contract §2)
    pub fn cache_budget_bytes(self, bytes: u64) -> Self;
    pub fn clock(self, clock: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self;  // for tests (section 6, Caches)

    pub async fn search_places(&self, region: Region, options: SearchOptions) -> Result<SearchResult, Error>;
    pub async fn get_place(&self, origin: &str) -> Result<PlaceRecord, Error>;
    pub async fn describe_service(&self) -> Result<ServiceDescription, Error>;
    pub async fn describe_tileset(&self, slug: &str) -> Result<Tileset, Error>;
}
```

`blocking::AtgeoClient<T = blocking::UreqTransport>` has the same constructors and the same four methods without `async`, over `blocking::HttpTransport`. Configuration is by value on the new client (`AtgeoClient::new().server("http://localhost:8000")`) rather than through a separate builder type: there are three options, and every one of them must be set before the first call, which taking `self` by value enforces. `AtgeoClient` is `Send + Sync` whenever `T` is; share it by reference or in an `Arc`, one per server for the life of the process.

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Region {
    /// Radius in metres.
    Circle { lat: f64, lon: f64, radius: f64 },
    /// Degrees. min_lon > max_lon crosses the antimeridian.
    Bbox { min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64 },
}
impl Region {
    pub const fn circle(lat: f64, lon: f64, radius: f64) -> Self;
    pub const fn bbox(min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64) -> Self;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SortMode { #[default] Fused, Distance, Similarity }

#[derive(Clone, Debug, Default)]
pub struct SearchOptions { /* text, dataset, collection: Option<String>; sort: SortMode */ }
impl SearchOptions {
    pub fn new() -> Self;
    pub fn text(self, text: impl Into<String>) -> Self;
    pub fn dataset(self, dataset: impl Into<String>) -> Self;
    pub fn collection(self, collection: impl Into<String>) -> Self;
    pub fn sort(self, sort: SortMode) -> Self;
}
```

A call reads `client.search_places(Region::circle(39.9526, -75.1652, 1000.0), SearchOptions::new().text("Starbux")).await?`. `Region` does not validate on construction: `Region::circle(f64::NAN, 0.0, 10.0)` builds, and `search_places` rejects it (Errors, below), so that the contract's order of checks (§3) holds whichever fault a call has. `SearchOptions` keeps its fields private behind setters, so that an option added later breaks nobody.

```rust
pub type Place = Arc<serde_json::Map<String, serde_json::Value>>;

#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct SearchResult { pub places: Vec<SearchHit>, pub complete: bool, pub overview: bool, pub tiles: TileCounts }

#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileCounts { pub fetched: usize, pub failed: usize }

#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub origin: Option<String>,
    pub place: Place,              // the record value as served
    pub importance: Option<i64>,
    pub distance: f64,             // metres
    pub score: Option<f64>,        // 0..=1, None without text
}
impl SearchHit {
    pub fn name(&self) -> Option<&str>;        // place["name"] when that is a string
    pub fn location(&self) -> PlaceLocation;   // locate(place), contract §5
}

#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct PlaceRecord { pub origin: String, pub place: Place, pub importance: Option<i64> }
// name() and location(), as on SearchHit

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaceLocation { pub point: Option<Point>, pub bbox: Option<BoxLocation> }
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point { pub lat: f64, pub lon: f64 }
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoxLocation { pub south: f64, pub west: f64, pub north: f64, pub east: f64 }  // west > east crosses ±180
```

The result types are `#[non_exhaustive]`: under semver, adding a public field to a struct whose fields are all public is a breaking change, and the results will grow (Kotlin's gained `location`) while the describe types mirror lexicons that gain fields. The cost is that an app cannot build one with a struct literal; that is the same trade the Kotlin port made with internal constructors. `PlaceLocation` is not called `Location`, which collides with too many app types; its box keeps the lexicon's names.

The describe types are `#[non_exhaustive]` structs deriving `Clone, Debug, Default, PartialEq`, every field an `Option` except the three lists the lexicon requires, which are `Vec`s that default to empty:

| Struct | Fields |
|---|---|
| `ServiceDescription` | `did: Option<String>`, `tilesets: Vec<ServedTileset>` |
| `ServedTileset` | `slug: Option<String>`, `collections: Vec<CollectionRef>` |
| `CollectionRef` | `dataset`, `collection: Option<String>` |
| `CollectionAttribution` | `dataset`, `collection`, `release`, `source`, `attribution: Option<String>`, `licenses: Option<Vec<String>>` |
| `CollectionInfo` | the `CollectionAttribution` fields, plus `record_count: Option<i64>`, `location_formats`, `containment_types`, `attributes: Option<Vec<String>>`, `categories: Option<Vec<CategoryCount>>` |
| `CategoryCount` | `value: Option<String>`, `count: Option<i64>` |
| `Tileset` | `slug`, `published_at: Option<String>`, `extent: Option<Extent>`, `collections: Vec<CollectionInfo>`, `references: Option<Vec<CollectionAttribution>>` |
| `Extent` | `north`, `south`, `east`, `west: Option<String>` |

Every response is read by hand from a `serde_json::Value` (`wire.rs`), never through `#[derive(Deserialize)]`, whose generated code fails on a field of the wrong type where the contract wants it read as absent (§1). A missing or wrong-typed field is `None`; a list the lexicon requires that is missing or not an array is empty, and an optional list is `None`; in a `Vec<String>` a non-string element is dropped, and in a list of objects a non-object element is dropped while an object with no readable field still maps, to a struct of `None`s; an `extent` that is not an object is `None`; unknown keys are ignored. An `i64` field (`record_count`, `count`) applies the importance rule (section 6). `published_at` and the extent's edges stay strings, as served. With the optional `serde` feature, every public type derives `Serialize` and `Deserialize` for apps that persist what they fetched (it enables serde's `rc` feature, for `Place`); the derived `Deserialize` is strict and never used on a server response.

### Place values

A place is arbitrary JSON and must be surfaced untouched (contract §1). It is a `serde_json::Map`, behind an `Arc`. `serde_json::Value` is what the ecosystem passes JSON around as, and it keeps every key and nested value, with two limits that `CONFORMANCE.md` records: keys come out sorted rather than in served order, because `Map` is a `BTreeMap` unless serde_json's `preserve_order` feature is on (the contract does not require order, and the Swift port does not keep it either); and integers beyond 64 bits become doubles, exactly as in JavaScript. Do not enable `preserve_order`, or any other serde_json feature that changes behaviour (`arbitrary_precision`, `float_roundtrip`, `unbounded_depth`): Cargo unifies features across the build, so a library that turns one on changes `serde_json` for every crate in the app.

The `Arc` is there because a place is shared, not copied. The client keeps the latest search's parsed tiles to make a repeat search cheap (section 6, Caches), and a hit's `place` points into that memo. Measured over the 15,849 places of the Philadelphia tiles (section 5), deep-cloning every `Map` takes 1.27 s, 80 µs a place, while cloning the `Arc`s takes 0.7 ms. `Arc` also makes the place immutable to the app, which plain `Map`s in a shared memo could not be. An app that wants its own copy writes `(*hit.place).clone()`.

`name()` and `location()` are the accessors contract §14 allows; `location()` is built by the same `locate()` the ranker uses, so it cannot disagree with `distance`.

### Errors

```rust
#[non_exhaustive]
#[derive(Debug)]
pub enum Error {
    /// A non-2xx answer from the server (contract §1).
    Atgeo(AtgeoError),
    /// A 2xx answer the client could not use: not JSON, or without what the call needs (contract §1).
    Decoding(DecodingError),
    /// No answer arrived: whatever the transport returned, boxed.
    Transport(BoxError),
    /// A bad argument, found before any request (contract §3).
    InvalidArgument(ArgumentError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AtgeoError { pub code: String, pub message: String, pub status: u16 }   // Display: "{message} ({code})"

#[derive(Debug)]
pub struct DecodingError { /* message; source: Option<serde_json::Error> */ }

#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArgumentError { InvalidRegion(&'static str), SimilarityRequiresText }
```

One enum, as Rust callers expect, with a variant per kind the contract keeps apart: the server's refusals (whose `code` stays the server's namespace), unusable answers, transport failures, and argument errors. `Display`, `std::error::Error` and `source()` are written by hand rather than with `thiserror`, which would be the crate's only proc-macro dependency for about forty lines. `Error::Transport` holds the transport's own error, which is as close to "unwrapped" (contract §1) as a typed `Result` gets: `err.downcast_ref::<reqwest::Error>()` reaches it. Argument errors are returned, not panicked: a region is often computed from data, and a panic in a library over input it could reject is wrong. Since an `async fn` body does not run until polled, the error appears on the first poll; either way, no request is made.

## 4. Transport

```rust
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

#[derive(Clone, Debug)]
pub struct HttpResponse { pub status: u16, pub body: Vec<u8> }   // body decoded: no Content-Encoding left on it

pub trait HttpTransport: Send + Sync {
    /// GET the URL exactly as given. Return a response for every status; fail only when no response arrived.
    /// Must not cache by default. Dropping the returned future must abandon the request.
    fn get(&self, url: &str) -> impl Future<Output = Result<HttpResponse, BoxError>> + Send;
}

pub mod blocking {
    pub trait HttpTransport: Send + Sync {
        /// The same, blocking. Called from several threads at once.
        fn get(&self, url: &str) -> Result<HttpResponse, BoxError>;
    }
}
```

TRANSPORT-DETAILS

## 5. Concurrency and cancellation

CONCURRENCY-DETAILS

## 6. Implementing the contract in Rust

Pointers for the parts where Rust's defaults, or a crate's, would give the wrong answer. Everything else is a direct transcription of the reference. Every recipe here was run as written.

### Normalization (contract §7)

```rust
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

fn is_js_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

pub(crate) fn normalize(s: &str) -> String {
    // 1. lowercase, 2. NFKD, 3. lowercase again, each over the whole string.
    let folded = s.to_lowercase().nfkd().collect::<String>().to_lowercase();
    let mut out = String::with_capacity(folded.len());
    let mut pending_space = false;
    for c in folded.chars() {
        if c.general_category() == GeneralCategory::NonspacingMark { continue; }   // 4. drop Mn
        if is_js_whitespace(c) { pending_space = !out.is_empty(); continue; }       // 5. collapse and trim
        if pending_space { out.push(' '); pending_space = false; }
        out.push(c);
    }
    out
}
```

`str::to_lowercase` is the Unicode default full case mapping with SpecialCasing's Final_Sigma condition, locale-independent: `ΟΔΟΣ` → `οδος`, `İ` → `i` + U+0307, `ẞ` → `ß`. It matches V8 on the fixture's abbreviations and on eight more contexts tried by hand (`Ο.Α.Σ.Α.`, `ΑΣ'Α`, `ΑΣ_ΒΣ`, `ΑΣ` + U+200B + `Α`, `aΣ.b`, `ΑΣ·Α`, `ΑΣ:Α`, `ΑΣ..Α`), so unlike Swift this port needs no hand-written sigma rule. Final_Sigma needs the whole string, which is why step 3 collects the NFKD output into a `String` first: `char::to_lowercase` has no context, and `"ΟΔΟΣ".chars().flat_map(char::to_lowercase)` gives `οδοσ`. Step 3's own Final_Sigma case (`𝚺𝚨𝚺` → `σας`) depends on it.

Three Unicode tables meet here, and they are different versions: the standard library's case mapping is Unicode 17.0 in Rust 1.97, `unicode-normalization` 0.1.26 carries 18.0, and the general category comes from `unicode-properties` 0.1.4 (feature `general-category`), at 17.0. Use `unicode-properties`, not `unicode-general-category` 1.1.0, whose 16.0 table classifies 39 fewer code points as Mn, so a mark NFKD splits off could survive step 4. All 41 fixture cases pass with this combination. Version skew between the tables, or between them and V8, is recorded in `CONFORMANCE.md` as known skew when a fixture case shows it, not worked around.

The whitespace set is spelled out because `char::is_whitespace`, `str::trim` and `split_whitespace` use Unicode's White_Space property, which includes U+0085 and excludes U+FEFF (checked over every code point). The contract's tokenizer is `split(' ')`.

### Jaro-Winkler (contract §7)

Run the transcription over `Vec<u16>` from `str::encode_utf16`, never over `chars()` or bytes: the emoji example in the contract only holds for code units. Two traps in a direct transcription: `i - reach` underflows `usize`, so write `i.saturating_sub(reach)`; and `lo..=hi` with `lo > hi` is empty in Rust (no Swift-style trap), which is what `starbux` against `bar` needs. Divide transpositions in `f64`.

Do not substitute `strsim`. Its `jaro_winkler` (0.11.1) fails 3 of the 33 fixture cases, `abcvwxyz`/`cabvwxyz` among them, and compares `char`s, so the emoji example scores 0.667 instead of 0.883.

### Numbers (contract §1, §3, §5, §6)

- `importance`, and the describe types' `i64` fields:

  ```rust
  fn importance_of(v: Option<&Value>) -> Option<i64> {
      let d = v?.as_f64()?;                        // None for anything but a JSON number
      (d.is_finite() && d.abs() < 9_223_372_036_854_775_808.0).then(|| d as i64)   // truncates toward zero
  }
  ```

  `Value::as_f64` converts an integer serde_json kept as `u64` or `i64` to the nearest double, which is the contract's precision loss: `9007199254740993` → `9007199254740992`. Verified: `1.9` → 1, `-1.9` → -1, `true` and `"7"` → absent, `9223372036854775807` and `-9223372036854775808` → absent (both round to ±2^63), `9223372036854774784` exact, `18446744073709551616` and `1e300` → absent. The guard comes before the cast because `as` saturates where the contract wants absent.
- Coordinates (§5): `str::parse::<f64>` rejects surrounding whitespace, trailing text, `1e`, `.`, `0x10` and `1_000`, and accepts `inf`, `infinity` and `nan` in any case, which the `is_finite` check after parsing removes. Accept `Value::String` through `parse` and `Value::Number` through `as_f64`; anything else, an array included, is no location (contract §16). `CONFORMANCE.md` margins against `parseFloat`: no location for ` 1.5`, `1.5abc`, `1e`, `1_000` and `0x10`, where `parseFloat` reads 1.5, 1.5, 1, 1 and 0; agreement on `+1.5`, `.5`, `1.`, `-0`, `1e3`, `1e+5`, `Infinity` and `NaN`.
- `f64::round` rounds half away from zero, which is `Math.round` for the non-negative scores `round3` sees (`(x * 1000.0).round() / 1000.0`), and harmless in snapping, where the epsilon test makes the tie rule irrelevant (§3).
- Snapping: `floor` and `ceil` cast with `as i64`, so the hundredths are integers from the start. Format from the integer: with `a = units.unsigned_abs()`, `format!("{}{}.{:02}", if units < 0 { "-" } else { "" }, a / 100, a % 100)`. `format!("{:.2}", units as f64 / 100.0)` gives the same strings on every worked example but prints `-0.00` for a negative zero.
- `f64::sin`, `cos`, `asin`, `atan2`, `sqrt`, `to_radians` and `to_degrees` from the standard library. The §6 table matched the contract's values exactly on x86_64 Linux; compare to 1e-6 relative anyway, containment exactly.

### Truthiness (contract §1)

```rust
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(true, |d| d != 0.0),   // -0.0 != 0.0 is false
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,                                                    // any array or object, empty or not
    }
}
```

### JSON (contract §1, §16)

Decode every body the same way:

```rust
fn parse_body(body: &[u8]) -> Result<Value, serde_json::Error> {
    let text = String::from_utf8_lossy(body);                 // invalid UTF-8 becomes U+FFFD; borrows when valid
    serde_json::from_str(text.strip_prefix('\u{FEFF}').unwrap_or(&text))
}
```

`JSON.parse` sees text that `response.text()` produced, which drops a leading byte-order mark and turns invalid UTF-8 into U+FFFD. `serde_json::from_slice` fails on both, so decode leniently first. Verified margins for `CONFORMANCE.md`, all from malformed input, each of which makes a tile fail where the reference carries on: a number literal that overflows a double (`1e400`) is an error, where `JSON.parse` reads Infinity; a lone surrogate escape (`"\ud800"`) is an error, since a Rust `String` cannot hold one; nesting deeper than 127 arrays or objects is an error (serde_json's recursion limit). Where the two agree: `1e-400` is 0, the last of duplicate keys wins, `-0` stays negative zero, and an integer past 64 bits becomes the nearest double. FLOAT-ROUNDTRIP

### String comparison (contract §4.3, §8, §10)

`str`'s `Ord` compares UTF-8 bytes, which is code point order; the contract orders tile URLs, origins and the `get_place` scan's "lowest URL" by UTF-16 code units. They differ once a string holds a character above U+FFFF next to one in U+E000 to U+FFFF (`"\u{FF61}"` sorts before `"\u{10000}"` by `str` and after it by code units). Compare with `a.encode_utf16().cmp(b.encode_utf16())`. Equality needs no such care: two Rust strings are equal exactly when their code units are, and there is no canonical equivalence in `==`.

### Ranking (contract §8)

`slice::sort_by` is stable. Chain the contract's comparators with `Ordering::then_with` in the table's order, each a comparison, never a subtraction. Three traps:

- `Option<String>`'s derived `Ord` puts `None` first; the contract's `byOrigin` puts a null origin after every string. Match on the pair instead.
- `f64::total_cmp` is not the contract's order: it puts `-0.0` before `0.0`, where subtraction ties them. Use `partial_cmp`, with NaN after every number for the case it returns `None` (only out-of-range place coordinates produce a NaN distance; Kotlin records the same decision).
- `byImportance` compares `i64`s with `cmp`, so the full range is safe; a transcription of `b - a` overflows.

### Caches (contract §10)

`TileCache` holds each tile's body as served, not its parsed records, with the keys (§4.6) of its usable records for the `get_place` scan; a tile counts as `body.len()`. PARSED-MEMORY `ParsedTiles` keeps the parsed records of the latest search's tiles outside the budget, as contract §10 allows, as `Arc<[TileRecord]>` keyed by URL with the cache entry's generation number, so that a search uses a memoized tile only while `TileCache` still holds that same entry; fetching and recency are exactly as without the memo.

There is no ordered map in the standard library, and the cache does not need a crate for one. `TileCache` is a `HashMap<String, Entry>` where each entry carries a recency tick from a counter, plus a `BTreeMap<u64, String>` from tick to URL: a read moves the entry to a fresh tick, an insert subtracts a replaced entry's size, and eviction takes `pop_first()` until the total is within budget, which lets one large tile evict several. `find(key)` iterates the `HashMap` without touching ticks (contract §10 wants the scan not to count as use) and keeps the lowest URL by code units whose key set holds the key.

`TtlCache` takes the client's clock, `Fn() -> SystemTime`; an entry is fresh while `clock() < expires`, comparing `SystemTime`s directly, so a clock that steps backwards needs no `duration_since` error handling. The default is `SystemTime::now`, wall-clock time as the contract says, and deliberately not `Instant`: the standard library documents that whether a suspend counts as elapsed time is unspecified, and its implementations use `CLOCK_MONOTONIC` on Linux and `CLOCK_UPTIME_RAW` on macOS, neither of which advances while the machine sleeps, so a laptop that slept through the hour would keep serving an expired tile list. An insert drops expired entries first (§14), so that a client shared for the life of a process does not grow without bound under a panning map.

The caches sit behind `std::sync::Mutex`es that are never held across an `.await` or a transport call. A poisoned lock is recovered with `PoisonError::into_inner`: every critical section leaves the cache consistent before anything in it can panic, and a cache is an optimization not worth failing every later call over.

## 7. Testing

`cargo test`, with the integration tests in `tests/` and the fixtures read with `include_str!`. The built-in harness has no parametrized tests, so a fixture test loops over its cases, collects every failure, and fails once with a message naming each failing case; `libtest-mimic` would give one test per case at the price of a dev-dependency and is not worth it. `tokio` is a dev-dependency only, for the async tests' runtime and its paused clock.

The fake server is one routing core behind both transport traits, so that every client-driven test runs against both clients. It:

- is configured with tilesets (slug, collections, tiles whose records are given as `serde_json::Value`s, not as the client's own record type, so that malformed records are expressible), a `tiles_for` override returning an enum with the three shapes the reference's tests use (a URL list, tiles with an overview flag, or an error and message), a `fail_tiles` list, a `server` base, `go_offline()`, a raw-response override by URL that bypasses routing and validation (how `robustness.rs` serves the contract's §16 bodies), and per-URL delays, slept with `tokio::time::sleep` behind the async trait and `std::thread::sleep` behind the blocking one, with a count of the peak number of requests in flight and of requests dropped before they finished (a guard in the async face counts its own drop);
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors, and fails every request with a boxed `io::Error` when offline;
- records every request URL for the privacy tests (§12), behind a `Mutex`, since the blocking client calls it from several threads. The transport seam carries a URL and nothing else, so the method (always GET) and the body (never one) are fixed by construction; the ported tests that assert them keep their names and their remaining assertions. Headers belong to the real transports, which `transports.rs` checks;
- validates its own traffic. There is no Rust validator for atproto lexicons, so the fake implements the contract's minimum (§13) plus what `fakeServer.test.ts` asserts, as the Kotlin spec lists it: at construction, a string `slug` on every tileset, an object `value` with a string `name` on every record, and an integral `importance` when present; for requests, unknown and missing parameter names are a 400 `InvalidRequest`, `bbox` must match the §13 regular expression (written as a hand-rolled check, so the tests need no `regex` crate), and `uri` must have a scheme, a colon and no spaces. Its own responses carry the lexicon's required fields. The lexicon JSON stays vendored, with its own `SOURCE`.

Both clients through one test body: `common::Client` wraps either client behind methods that block, driving the async one on a current-thread `tokio` runtime built with `start_paused(true)`, so that the fake's delays cost no wall time, and a `both!` macro turns one body into `<name>_async` and `<name>_blocking` tests. The blocking half compiles only with the `blocking` feature.

Test files map one to one onto the reference's `test/*.test.ts` as `tests/<name>.rs`, each `describe` a module and each `it` a test with the same words in snake case (`TypeError` and "synchronously" become `InvalidArgument` and "before any request"), so that a reviewer can diff coverage by eye. The two source-scan suites in `client.test.ts` are not ported; their counterparts are the `--no-default-features` build in CI and `cargo deny`. `ranking.rs` drives each scenario through the client and the fake with one tile at `https://places.atgeo.org/tiles/t0.json`, with the reference's membership assertions. `region.rs` and `distance.rs` add the contract's worked-example tables (§3, §6).

Four files have no reference counterpart. `wire.rs` covers the lenient readers directly: the importance, coordinate and truthiness tables of section 6, the describe-type rules of section 3, the error-body rule, and the JSON margins `CONFORMANCE.md` lists. `robustness.rs` covers the contract's §16 behaviours through the raw-response override. `concurrency.rs`: with 20 delayed tiles the peak in flight is 8, on both clients; dropping a search future while tiles are in flight drops every one of their requests; a search answered entirely from cache completes on its first poll (`FutureExt::now_or_never` returns `Some`), which the contract asks for and the Kotlin port cannot give; a failed getTiles caches nothing, so a retry sends a second request; and `AtgeoClient<FakeServer>` is `Send + Sync` and its `search_places` future is `Send`, asserted at compile time. `transports.rs` is next.

The default transports get tests of their own against a loopback HTTP server written on `std::net::TcpListener`, since the fake replaces them everywhere else: a 4xx with a JSON error body and a 4xx with an empty body (both `Ok(HttpResponse)` with the status and body bytes, since a transport never produces `Error::Atgeo`), a same-scheme redirect, a gzipped body and an empty body labelled gzip, the body cap (exactly `max_body_bytes` is read; one byte more fails, and so does a few-kilobyte gzip body that decodes past it), a server that trickles bytes slower than the read timeout, and the request headers, which must be the same set on two different requests. `ReqwestTransport` adds cancellation: dropping the future mid-body closes the connection, which the loopback server observes.

`examples/e2e.rs` runs both clients against a live garganorn, configured by `ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION` and `ATGEO_REGION`, the variables `scripts/e2e.ts` reads. It is not part of `cargo test`.

CI: GitHub Actions. `cargo fmt --check`; `cargo clippy --all-targets --all-features -- -D warnings`; `cargo test` on `ubuntu-latest`, `macos-latest` and `windows-latest` with `--no-default-features`, with the defaults and with `--all-features`; the same with the MSRV toolchain on Linux; `RUSTDOCFLAGS="-D warnings" cargo doc --all-features --no-deps`, which also builds the README's examples as doctests; and `cargo deny check` for licences (permissive only) and advisories.

## 8. Decisions and open questions

| Decision | Choice | Why |
|---|---|---|
| Async client | runtime-agnostic: no spawning, no runtime dependency | runs on any executor; dropping the future cancels everything in it |
| Blocking client | `blocking` feature, ureq, scoped threads | code without a runtime, and async code that wants all of a search off its executor (section 5) |
| Shared core | a sans-I/O engine both drivers call | one implementation of the contract |
| Transport trait | a `Send` future from return-position `impl Trait`, boxed errors | no `async-trait` dependency; futures that multi-threaded runtimes accept; one error type for every transport |
| Place representation | `Arc<serde_json::Map>` | untouched JSON in the ecosystem's type; sharing costs 0.7 ms where deep copies cost 1.27 s |
| JSON | `serde_json` with no behaviour-changing features | Cargo's feature unification would impose them on the app |
| Unicode tables | `unicode-normalization` and `unicode-properties` | `unicode-general-category`'s table is a version behind |
| Importance type | `i64`, read through `f64` | contract §1 |
| Errors | one `#[non_exhaustive]` enum, hand-written impls | one `Result` type for callers; no proc-macro dependency |
| Result types | `#[non_exhaustive]` | fields can be added in a minor release |
| Tile cache | bodies and key sets, plus the latest search's parsed tiles; LRU from a `HashMap` and a `BTreeMap` of ticks | MEMO-WHY; no LRU crate |
| TTL clock | `SystemTime` | `Instant` may stop while a machine sleeps |
| MSRV | MSRV-ROW |
| Beta distribution | git dependency pinned to a commit | free, no publishing step, pins like the JS client |

Open:

1. `wasm32`. The transport trait requires `Send` futures, which reqwest's browser backend does not give, and the JS client already serves browsers. A `?Send` variant of the trait for `wasm32` is possible if a Rust-in-the-browser app turns up.
2. Cancellation for the blocking client. It has none beyond the transport's timeouts. A cancellation token argument is easy to add and not needed until someone asks.
3. Reserving `atgeo` on crates.io before the beta ends. A name nobody holds can be taken; publishing a placeholder is the maintainer's call.
4. The default cache budget, with the size of the parsed-tile memo beside it (contract §15).
