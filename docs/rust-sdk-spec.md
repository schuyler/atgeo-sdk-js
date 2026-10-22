# Rust SDK specification

A Rust port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the crate, its public API, and the decisions that are specific to Rust. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: built, in schuyler/atgeo-sdk-rs. This document now describes the port as built; the port's `DECISIONS.md` lists where the build departed from the proposal and why, and its `CONFORMANCE.md` the margins against the reference. The recipes in section 6 were run with Rust 1.97 against the fixtures at `dae7995` and the contract's worked tables, and pass: `normalize.json` 41/41, `jaro-winkler.json` 33/33 (worst distance from the fixture 4.8e-7), the contract's §3 bbox table, the exact expectations in `region.test.ts` and its 93-box grid test, the §6 distance table (bit-identical on x86_64 Linux), and the 12 ranking scenarios through a transcription of §4.6 to §4.9. The transport and concurrency claims in sections 4 and 5 were measured against a loopback server. An independent review then re-ran the recipes, the measurements and an API sketch (which also built and passed on 1.85.0); its findings are folded in, among them a panic in `f64::clamp` on a reversed box, tests that could not reach `pub(crate)` code, and a feature layout that compiled ureq into every blocking build. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Rust: an async client that runs on any executor because it has none of its own and spawns nothing (its default transport, reqwest, does need Tokio), and a blocking client for code without one, with the same methods and results; owned result types; one error enum; a client that is `Send + Sync` and meant to be shared.
- A small dependency tree: 13 crates for the core, with the default transports behind features.

Non-goals for the first release: `wasm32` (the JS client serves browsers), persistence, `no_std`, C or UniFFI bindings, and a typed `Place` model.

## 2. Crate

Repository: `schuyler/atgeo-sdk-rs`. Crate `atgeo`, which is unclaimed on crates.io at the time of writing.

```
Cargo.toml
src/
  lib.rs              the public names, re-exported; the README as crate docs, so its examples compile as doctests
  client.rs           AtgeoClient: the async driver (section 5)
  blocking.rs         blocking::AtgeoClient and blocking::HttpTransport (feature "blocking"); UreqTransport (feature "ureq")
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
                      (every module carries #[cfg(test)] unit tests for its internals; section 7)
tests/
  fixtures/           vendored from atgeo-sdk-js fixtures/; SOURCE names the atgeo-sdk-js commit
  fixtures/lexicon/   vendored from atgeo-sdk-js test/lexicon/ as is, including its SOURCE, which names the garganorn commit
  common/             the fake server (both transport traits), the loopback HTTP server, a client wrapper that runs one test body against both clients (section 7)
  *.rs                one file per client-driven reference test file, plus robustness.rs, concurrency.rs and transports.rs (section 7)
examples/e2e.rs       end-to-end run against a live garganorn
CONFORMANCE.md        where this port reads malformed input differently from the reference (§5, §14)
deny.toml             cargo-deny policy: permissive licences only, no known advisories
```

Edition 2024, `rust-version = "1.85"`. 1.85 is the floor because edition 2024 needs it and so do the current reqwest (0.13), ureq (3.5) and tokio (1.54); the transport trait alone needs only 1.75 (return-position `impl Trait` in traits, measured: it fails on 1.74.1). A trap waits under that floor: with the newest versions, reqwest → `url` → `idna` resolves `icu_*` 2.4, which needs rustc 1.88. Cargo's MSRV-aware resolver, the default under edition 2024, honours `rust-version` and picks `icu_*` 2.1 instead, and the whole graph then builds on 1.85.0 (measured); stable cargo resolves the crate's committed lockfile the same way, and CI builds that lockfile with 1.85. An app resolves its own lockfile, though: an edition-2021 app on cargo 1.85 resolved `icu_provider` 2.4 and failed to build (measured). The README tells apps on 1.85 to 1.87 to set `resolver = "3"`, and a CI job builds such an app on 1.85. Pinning `icu_provider` alone does not work: `cargo update -p icu_provider --precise 2.1.1` fails, since `icu_normalizer` 2.4 requires `icu_provider` 2.4 (found in the port's review), and `icu_*` 2.2 and `idna_adapter` 1.2.2 already need 1.86.

```toml
[dependencies]
serde_json = "1"
futures-util = { version = "0.3", default-features = false, features = ["alloc"] }
unicode-normalization = "0.1.26"
unicode-properties = { version = "0.1.4", default-features = false, features = ["general-category"] }
reqwest = { version = "0.13", default-features = false, features = ["rustls", "gzip"], optional = true }
ureq = { version = "3.5", default-features = false, features = ["rustls", "platform-verifier"], optional = true }
flate2 = { version = "1", optional = true }
serde = { version = "1", features = ["derive", "rc"], optional = true }

[features]
default = ["reqwest"]
reqwest = ["dep:reqwest"]                       # ReqwestTransport, the async client's default transport
blocking = []                                   # blocking::AtgeoClient and blocking::HttpTransport
ureq = ["blocking", "dep:ureq", "dep:flate2"]   # blocking::UreqTransport, the blocking client's default transport
serde = ["dep:serde"]

[dev-dependencies]
tokio = { version = "1.54", features = ["rt", "rt-multi-thread", "macros", "test-util", "time"] }
flate2 = "1"

[[example]]
name = "e2e"
required-features = ["reqwest", "ureq"]
```

Counted with `cargo tree -e normal` over the 1.85 lockfile: the core (`serde_json`, `futures-util` with only `alloc`, the two Unicode crates) is 13 crates, the default build 97, the blocking client with ureq and without reqwest 42, and every feature together 105. The blocking client and its trait cost nothing on their own; an app with its own blocking HTTP stack enables `blocking` without `ureq`. reqwest's defaults are turned off to drop `http2`, `charset` and `system-proxy`, none of which the client needs; an app that wants HTTP/2 passes its own `reqwest::Client` (section 4). reqwest 0.13's `rustls` feature uses the aws-lc-rs crypto provider, a C build, with the operating system's root certificates; its `rustls-no-provider` alternative was tried with `ring` and panics at `Client::builder().build()` unless a process-wide provider is installed, which a library must not do, so the spec takes the default provider. ureq's `rustls` uses `ring`, and `platform-verifier` with `RootCerts::PlatformVerifier` (section 4) makes it trust the operating system's roots like reqwest does (checked against places.atgeo.org); `webpki-roots`' bundled Mozilla list is still compiled in through ureq's `rustls` feature, unused. With every feature on, rustls is built with both crypto providers and both transports still work (checked). ureq is built without its `gzip` feature; section 4 says why. Nothing pulls in OpenSSL. `reqwest::ClientBuilder`, `reqwest::Client` and `ureq::Agent` appear in the public API (section 4), so a major release of either library is a major release of this crate. Test scope: `tokio` and `flate2`, which builds the gzip bodies the transport tests serve.

Licence: BSD-3-Clause, the same `LICENSE` file as the other repositories. Distribution during beta mirrors the JS client: not on crates.io. Depend on the repository pinned to a commit, `atgeo = { git = "https://github.com/schuyler/atgeo-sdk-rs", rev = "<sha>" }`; the API is still moving. Publish to crates.io as `atgeo` once the wire contract settles.

## 3. Public API

Names follow the Rust API guidelines. `get_place` keeps the verb, as in the JS and Kotlin clients and the XRPC query it wraps; the guideline against `get_` prefixes is about field getters, not network calls.

```rust
#[cfg(feature = "reqwest")]
pub struct AtgeoClient<T = ReqwestTransport> { /* transport, server, caches */ }
#[cfg(not(feature = "reqwest"))]
pub struct AtgeoClient<T> { /* the same */ }

#[cfg(feature = "reqwest")]
impl AtgeoClient<ReqwestTransport> {
    pub fn new() -> Self;                                         // default server, ReqwestTransport::new(); also Default
}

pub const DEFAULT_SERVER: &str = "https://places.atgeo.org";
pub const DEFAULT_CACHE_BUDGET_BYTES: u64 = 50 * 1024 * 1024;

impl<T: HttpTransport> AtgeoClient<T> {
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

`blocking::AtgeoClient<T = blocking::UreqTransport>` has the same constructors and the same four methods without `async`, over `blocking::HttpTransport`. A default type parameter that names a type a disabled feature removes does not compile, which is why each client is declared twice under `cfg`, the blocking one on the `ureq` feature. `Default` is implemented beside every `new()` (clippy's `new_without_default` requires it); `new()` panics only if the TLS backend cannot initialise, and says so under `# Panics`. `Debug` is written by hand, since the client holds a boxed clock. Configuration is by value on the new client (`AtgeoClient::new().server("http://localhost:8000")`) rather than through a separate builder type: there are three options, all of them settings for a client nobody shares yet, and taking `self` by value means a client behind `&` or an `Arc` cannot be reconfigured under its callers. `AtgeoClient` is `Send + Sync` whenever `T` is; share it by reference or in an `Arc`, one per server for the life of the process.

```rust
#[non_exhaustive]
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

#[non_exhaustive]
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

#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaceLocation { pub point: Option<PlacePoint>, pub bbox: Option<PlaceBox> }
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacePoint { pub lat: f64, pub lon: f64 }
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaceBox { pub south: f64, pub west: f64, pub north: f64, pub east: f64 }  // west > east crosses ±180
```

The result types are `#[non_exhaustive]`: under semver, adding a public field to a struct whose fields are all public is a breaking change, and the results will grow (Kotlin's gained `location`) while the describe types mirror lexicons that gain fields. The cost is that an app cannot build one with a struct literal; that is the same trade the Kotlin port made with internal constructors. The same attribute is on `PlaceLocation` and its parts, on `AtgeoError`, on `HttpResponse` (which every app transport builds, through `HttpResponse::new`), and on `Region` and `SortMode`, which may gain kinds. `PlaceLocation` is not called `Location`, nor its parts `Point` and `Box`, names that collide with app types, `geo::Point` and `std::boxed::Box`; the box keeps the lexicon's names.

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

Every response is read by hand from a `serde_json::Value` (`wire.rs`), never through `#[derive(Deserialize)]`, whose generated code fails on a field of the wrong type where the contract wants it read as absent (§1). A missing or wrong-typed field is `None`; a list the lexicon requires that is missing or not an array is empty, and an optional list is `None`; in a `Vec<String>` a non-string element is dropped, and in a list of objects a non-object element is dropped while an object with no readable field still maps, to a struct of `None`s; an `extent` that is not an object is `None`; unknown keys are ignored. An `i64` field (`record_count`, `count`) applies the importance rule (section 6). `published_at` and the extent's edges stay strings, as served. With the optional `serde` feature, the data types derive `Serialize` and `Deserialize` for apps that persist what they fetched, and their persisted shapes are part of the API: `Region` is internally tagged (`#[serde(tag = "kind", rename_all = "snake_case")]`, so a circle is `{"kind": "circle", "lat": …}`); `SortMode` uses its wire names (`rename_all = "lowercase"`); the result types and `PlaceLocation`'s parts keep their Rust field names; and the describe types use `rename_all = "camelCase"`, so that a persisted one reads like the lexicon. The feature enables serde's `rc` feature, for `Place`. The errors, the clients and the transports derive neither. The derived `Deserialize` is strict and never used on a server response.

### Place values

A place is arbitrary JSON and must be surfaced untouched (contract §1). It is a `serde_json::Map`, behind an `Arc`. `serde_json::Value` is what the ecosystem passes JSON around as, and it keeps every key and nested value, with two limits that `CONFORMANCE.md` records: keys come out sorted rather than in served order, because `Map` is a `BTreeMap` unless serde_json's `preserve_order` feature is on (the contract does not require order, and the Swift port does not keep it either); and integers beyond 64 bits become doubles, exactly as in JavaScript. Do not enable `preserve_order`, or any other serde_json feature that changes behaviour (`arbitrary_precision`, `float_roundtrip`, `unbounded_depth`): Cargo unifies features across the build, so a library that turns one on changes `serde_json` for every crate in the app. Unification works the other way too: any other crate in the app can turn them on. So the client's code must be correct under any serde_json features (the recipes in section 6 are, including under `arbitrary_precision`), and the `CONFORMANCE.md` entries about key order and number literals say "with serde_json's default features".

The `Arc` is there because a place is shared, not copied. The client keeps the latest search's parsed tiles to make a repeat search cheap (section 6, Caches), and a hit's `place` points into that memo. Measured over the 15,849 places of the Philadelphia tiles (section 5) in a release build, deep-cloning every `Map` takes 0.09 to 0.12 s on a warm heap (6 to 8 µs a place) and 0.9 s on a fresh one, while cloning the `Arc`s takes 0.7 ms. `Arc` also makes the place immutable to the app, which plain `Map`s in a shared memo could not be. An app that wants its own copy writes `(*hit.place).clone()`.

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
#[non_exhaustive]
pub struct AtgeoError { pub code: String, pub message: String, pub status: u16 }   // Display: "{message} ({code})"

#[derive(Debug)]
pub struct DecodingError { /* message; source: Option<serde_json::Error> */ }

#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArgumentError { InvalidRegion(&'static str), SimilarityRequiresText, InvalidServer }
```

One enum, as Rust callers expect, with a variant per kind the contract keeps apart: the server's refusals (whose `code` stays the server's namespace), unusable answers, transport failures, and argument errors. `Display`, `std::error::Error` and `source()` are written by hand rather than with `thiserror`, which would add a proc-macro to every build to save about forty lines. No message repeats its source's, so that a report walking the chain (anyhow's `{:#}`) says each thing once: `Atgeo`, `Decoding` and `InvalidArgument` show their inner error and pass on its source, `Transport` displays `transport error` with the transport's error as its source, and a `DecodingError` from the parser displays `response is not JSON` with the parser's error as its source (the port first printed each message twice, found in its review). `Error::Transport` holds the transport's own error, which is as close to "unwrapped" (contract §1) as a typed `Result` gets: `err.downcast_ref::<reqwest::Error>()` reaches it. Argument errors are returned, not panicked: a region is often computed from data, and a panic in a library over input it could reject is wrong. Since an `async fn` body does not run until polled, the error appears on the first poll; either way, no request is made. `server()` takes any string, so the server is checked at each call instead: one that is not an absolute http or https URL with a host, or that carries credentials, is `ArgumentError::InvalidServer` before any request (section 4, URLs).

## 4. Transport

```rust
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

#[non_exhaustive]
#[derive(Clone, Debug)]
pub struct HttpResponse { pub status: u16, pub body: Vec<u8> }   // body decoded: no Content-Encoding left on it
impl HttpResponse { pub fn new(status: u16, body: Vec<u8>) -> Self; }

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

The trait is not object-safe (a `Box<dyn HttpTransport>` is error E0038, measured), which is why the client is generic over its transport rather than holding a trait object. An implementor writes `async fn get(&self, url: &str) -> Result<HttpResponse, BoxError>` in its `impl`, and the compiler checks the `Send` bound there: an implementation holding an `Rc` across an `.await` is rejected at the `impl`, not at some distant call site. A trait declared with a plain `async fn` instead could not promise that the client's own futures are `Send`, and `tokio::spawn` would refuse them. With the bound, `tokio::spawn(async move { client.search_places(..).await })` compiles for any `T: HttpTransport + 'static` behind an `Arc` (measured). Both traits are implemented for `&T` and `Arc<T>` wherever `T` implements them, so that one transport, the test fake among them, can serve two clients and be inspected afterwards.

Both transports return an `HttpResponse` for every status and never produce `Error::Atgeo`. The conversion of a non-2xx into `Error::Atgeo` happens above the seam, in `xrpc.rs` (in the tile loop a non-2xx is a failed tile, never an error), so that it applies to the fake server's responses as much as to the real ones: the body is parsed with `parse_body` (section 6), `error` and `message` are each read only if they are strings, and anything missing falls back to `HttpError` and `HTTP {status}` (contract §1, §16). The body is always in hand before the status is judged. XRPC URLs are built by percent-encoding each query value over everything but the RFC 3986 unreserved characters (`A-Z a-z 0-9 - . _ ~`), which encodes `+` as `%2B` and a space as `%20`, as the contract allows (§1); the encoder is ten lines, so the core needs no `url` or `percent-encoding` dependency. A call with no parameters (`describeService`) keeps the reference's trailing `?`, so that a URL-keyed override in the test fake matches the same URL in every port.

### URLs

The engine checks and prepares every URL before a transport sees one, as the Python port's does, so that both transports send the same bytes. A tile URL that is not an absolute http or https URL with a host is a failed tile, on both clients, as it is in Node's `fetch`, and so is one that carries credentials (`https://user:pw@host/…`, contract §4.4), which reqwest would otherwise send as `Authorization: Basic` (the port first fetched them, found in its review). A redirect to a URL with credentials is a transport error, in both transports. Then:

```rust
/// Trim leading and trailing controls and spaces; drop tab, LF and CR; percent-encode space, other
/// controls, non-ASCII and " < > ` { }; leave %XX alone.
fn prepare_url(url: &str) -> String {
    let url = url.trim_matches(|c: char| c <= ' ');
    let mut out = String::with_capacity(url.len());
    for &b in url.as_bytes() {
        match b {
            b'\t' | b'\n' | b'\r' => {}
            b'"' | b'<' | b'>' | b'`' | b'{' | b'}' => out.push_str(&format!("%{b:02X}")),
            0x21..=0x7E => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
```

`https://h/a b.json` becomes `https://h/a%20b.json` and `café` becomes `caf%C3%A9`, which is what the reference's WHATWG URL parsing does to those characters (checked against the Python recipe, which gives the same strings); a clean URL is unchanged. The six punctuation characters are the rest of WHATWG's path percent-encode set: left raw, ureq's `http::Uri` rejected `<`, `>` and `` ` `` and failed the tile, and sent the other three unencoded (found in the port's review; WHATWG leaves `` ` ``, `{` and `}` raw in a query, where encoding them decodes to the same value). The trim is WHATWG's too: without it a tile URL with a stray leading space was a failed tile. reqwest would do the same and more on its own; ureq would not (section 4, below), so the step is what makes them agree. The WHATWG rules beyond these characters (a backslash read as `/`, `..` segments resolved) are reqwest's alone; `CONFORMANCE.md` lists them as the difference between the two transports. The tile cache measures a tile as `body.len()`, the decoded length.

### `ReqwestTransport` (feature `reqwest`)

```rust
pub struct ReqwestTransport { /* client: reqwest::Client, max_body_bytes: usize */ }
impl ReqwestTransport {
    pub fn new() -> Self;                                   // client_builder().build(); 32 MiB cap; also Default
    pub fn client_builder() -> reqwest::ClientBuilder;      // the settings below: start here for a client of your own
    pub fn with_client(client: reqwest::Client) -> Self;    // an app's own client (HTTP/2, proxies, its own TLS)
    pub fn max_body_bytes(self, bytes: usize) -> Self;
}
```

`client_builder()` returns `reqwest::Client::builder().referer(false).connect_timeout(10 s).read_timeout(30 s)` with a redirect policy that keeps reqwest's limit of ten and refuses a redirect to a URL with credentials, and `new()` builds it. An app that wants HTTP/2 or its own TLS starts from `client_builder()` and passes the result to `with_client`, so that it keeps the privacy settings below; a client built from `reqwest::Client::builder()` instead brings the `Referer` back (measured: a default client sent the full getTiles URL, bbox and all, as the `Referer` to the host a redirect named). The transport sends `Accept: application/json` and `User-Agent: atgeo-client-rust` on each request (contract §12, item 5), so an app's own client sends that `User-Agent` too: reqwest fills in a client's default headers only where the request has none (`async_impl/client.rs` in 0.13.5). Measured against a loopback server with reqwest 0.13.5:

- **reqwest needs Tokio.** It spawns a Tokio task per connection, and run under another executor (`futures::executor::block_on`) it panics: "there is no reactor running, must be called from the context of a Tokio 1.x runtime". The client is runtime-agnostic; this transport is not. An app on another runtime supplies a transport built on its own HTTP stack.
- **Referer.** By default reqwest adds a `Referer` header on every redirect hop carrying the previous URL in full, query included, to another host too. A redirected getTiles call would hand the snapped bbox, dataset and collection to whatever host the redirect names, which contract §14 rules out (a search sends nothing but the snapped box, dataset and collection). `referer(false)` removes it, which is why an app's own client should start from `client_builder()`.
- Headers: `accept: application/json`, `accept-encoding: gzip` and `host`, and nothing else (no `user-agent` of reqwest's own), identical on every request, a 404 included. With the transport's `user-agent: atgeo-client-rust` added, and no `accept-language`, that is the set the transport test asserts.
- Every status is `Ok`: 404, 429, 500 and 503 came back with their bodies, each from exactly one request. reqwest never retries.
- Redirects: followed up to 10 hops, 303, 307 and 308 included, which meets the contract's "at least same-scheme" (§1). https → http is followed too; `https_only(true)` would refuse it, and like restricting tile URLs (contract §15) that is a decision for every SDK together. Authorization and cookie headers are dropped on a change of host. A redirect reqwest will not follow, to `file:` say, comes back as the 3xx itself, which the async client would report as `Error::Atgeo` with status 302 where ureq and `fetch` fail the request; so the transport returns an error for a 301, 302, 303, 307 or 308 that still carries a `Location` (found in the port's review).
- gzip: decoded automatically, with `content-encoding` and `content-length` removed afterwards. An empty body labelled gzip is `Ok` and empty.
- The body cap (contract §14) has to count decoded bytes as they arrive. `Response::bytes()` returned all 64 MiB of a 65 KB gzip body and peaked at 129 MiB of heap, twice the decoded size. Read chunks instead, which reqwest yields decoded and at most 4 KiB at a time:

  ```rust
  let mut body = Vec::new();
  while let Some(chunk) = response.chunk().await? {
      if chunk.len() > max - body.len() { return Err("response body exceeds max_body_bytes".into()); }
      body.extend_from_slice(&chunk);
  }
  ```

  With a 32 MiB cap that stops the same body at exactly 33,554,432 bytes, with 32 MiB of heap. Deflate expands at most about 1030 to 1, so a body that decodes past 32 MiB is at least 32 KB on the wire.
- Timeouts: `read_timeout` is a per-read idle timer (a 2-second body trickling every 100 ms succeeds under a 300 ms timer; a stall fails at 303 ms), and there is no total, as in the Kotlin port. A body-phase timeout reports both `is_timeout()` and `is_decode()`; it is a transport error either way, a failed tile inside a search.
- Proxies: `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` are honoured even with `system-proxy` off; that feature only adds the macOS and Windows system settings. No cookie jar and no cache, so the contract's no-persistence default (§10, §14) holds.
- Cancellation: dropping the future mid-body, or while waiting for headers, closed the socket within 0.3 ms on a multi-threaded runtime. The socket belongs to a task reqwest spawned, so on a current-thread runtime it closes when that runtime next runs: in the probe, not at all during 500 ms idle, then within 0.5 ms of the runtime being driven again. The transport test therefore runs its cancellation case on the multi-threaded runtime.

### `blocking::UreqTransport` (feature `ureq`)

```rust
pub struct UreqTransport { /* agent: ureq::Agent, max_body_bytes: usize */ }
impl UreqTransport {
    pub fn new() -> Self;                                   // config_builder().build(); 32 MiB cap; also Default
    pub fn config_builder() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope>;   // the settings below
    pub fn with_agent(agent: ureq::Agent) -> Self;
    pub fn max_body_bytes(self, bytes: usize) -> Self;
}
```

`config_builder()` returns `Agent::config_builder().http_status_as_error(false).timeout_connect(Some(10 s)).timeout_per_read(Some(30 s)).timeout_global(Some(120 s)).max_idle_connections_per_host(8).max_redirects(0).max_redirects_will_error(false)` with the platform verifier as its root store (`TlsConfig::builder().root_certs(RootCerts::PlatformVerifier)`), and `new()` builds it (compiled, and checked against places.atgeo.org). The transport sends `Accept: application/json`, `Accept-Encoding: gzip` and `User-Agent: atgeo-client-rust` itself (contract §12, item 5). Measured with ureq 3.5.0:

- By default a non-2xx is `Err(StatusCode(404))` with the body thrown away, which would lose the server's error code. `http_status_as_error(false)` makes every status `Ok` with its body.
- ureq's own gzip support is not used, for three reasons. Its body limit (`with_config().limit(n)`) counts wire bytes, not decoded bytes: `limit(32 MiB)` returned all 64 MiB of the 65 KB gzip body. `read_to_vec()` applies a silent 10 MiB default limit. And it fails an empty body labelled gzip with `Decompress("gzip", UnexpectedEof)`, where reqwest and the reference read it as empty. So the crate is built without ureq's `gzip` feature, the transport asks for gzip itself, and when the response's `Content-Encoding` is `gzip` and the body is not empty (a `fill_buf` check), it decodes through `flate2::bufread::MultiGzDecoder`, reading into a fixed 64 KiB buffer and failing once the decoded total passes the cap. That reads the tile identically, returns an empty gzip body as empty, and stops the 65 KB body at the cap with 32 MiB of heap. (`take(max + 1).read_to_end` peaks at twice the cap; avoid it.) `MultiGzDecoder` rather than `GzDecoder` reads a body of several gzip members, as `fetch` does, and `x-gzip` is decoded as `gzip`, as `fetch` does; reqwest does neither, which `CONFORMANCE.md` lists.
- Headers: `accept`, `accept-encoding: gzip`, `user-agent: ureq/3.5.0` and `host`, identical on every request. ureq adds its `user-agent`, which names its version, only when the request has none (`run.rs` in 3.5.0), so the transport's `atgeo-client-rust` replaces it. No `accept-language` is sent.
- Redirects. Left to itself, ureq reads a redirect's whole body before following it: against a loopback 302 carrying a 300 MiB body, the server wrote all 300 MiB (memory stayed flat, but a search waits for the download; reqwest reads none of it, measured the same way). So `config_builder()` also sets `max_redirects(0)` and `max_redirects_will_error(false)`, which hand the 3xx back as a response, and the transport follows redirects itself: for a 301, 302, 303, 307 or 308 with a `Location`, it resolves the location against the current URL, removing dot segments as reqwest and `fetch` do, prepares it as above, refuses anything but http and https, drops the 3xx response unread, and requests the next URL; an eleventh redirect is an error. Measured: the 302's server wrote 0 of its 300 MiB. No `Referer` is added; https → http is followed, as with reqwest.
- Timeouts: `timeout_per_read` is a per-read idle timer (the 100 ms trickle succeeds under 300 ms; a stall fails at 320 ms), and `timeout_connect` fired at its 300 ms in the probe. Unlike reqwest's transport, this one also sets a total, `timeout_global`, which fired on time (1.003 s for a 1 s setting): the blocking client cannot be cancelled, and with idle timers alone a server sending a byte every 29 s would hold a search, and its caller's thread, indefinitely. 120 s is far beyond a 2 MB tile on a slow link (16 s at 1 Mbit/s). ureq applies `timeout_global` per request, so the transport turns it into one deadline for the whole chain of redirects, passing what is left of it to each hop; otherwise eleven hops could take 22 minutes.
- Proxies: on by default, but not as reqwest reads them: ureq takes the first of `ALL_PROXY`, `HTTPS_PROXY` and `HTTP_PROXY` that is set and uses it for every scheme, tunnelling with CONNECT, and honours `NO_PROXY`. No cookies, no cache, no retries.
- One `Agent` shared by the eight worker threads pooled its connections: 40 requests went over 8 connections with 8 in flight at peak. ureq keeps only 3 idle connections per host by default, so 5 of the 8 would close after each search and the next search would pay for new TLS handshakes; hence `max_idle_connections_per_host(8)`.
- Tile URLs: ureq parses a URL with `http::Uri`, not by the WHATWG rules reqwest and `fetch` follow. Measured: a space in a path fails the tile (reqwest sends `%20`), a non-ASCII character goes out as raw UTF-8 (reqwest percent-encodes it), and a backslash or a `..` segment goes out as is (reqwest turns them into `/` and resolves them). `prepare_url` (above) removes the first two differences; the last two remain, garganorn's tile URLs contain neither, and `CONFORMANCE.md` lists them, as the Swift port's does for `URL(string:)`. Normalizing through the `url` crate would remove them too, at the price of `idna` and the `icu` crates in the blocking-only build.
- Cargo unifies features, so another crate in the app can switch ureq's `gzip` feature back on. ureq then decodes gzip itself and removes `Content-Encoding`, and the transport, which decodes only when that header is still there, reads the already-decoded stream through the same 64 KiB loop, so the cap on decoded bytes still holds. What changes is ureq's own handling of an empty body labelled gzip, which then fails the tile; `CONFORMANCE.md` notes it.

Any transport an app supplies must disable its own response cache, or accept that the contract's no-persistence default (§10, §14) no longer holds, and should not send a `Referer`. It sends whatever headers its own stack does, and the README says so (contract §12, item 5).

## 5. Concurrency and cancellation

Both clients drive the same engine. The engine owns the caches and does everything that is not I/O: it validates and plans a search (the bbox strings, the tile-list keys and which of them are cached), turns a getTiles response into a tile list, parses and stores a tile, and assembles the result (§4.5 to §4.9). Each driver supplies the requests and the concurrency.

The async driver, inside the caller's future and spawning nothing:

- Validate and plan, so that an invalid region returns `Error::InvalidArgument` on the first poll with no request made.
- The one or two tile lists go through `futures_util::future::try_join_all`. A cached list resolves without a request; the first error returns at once and drops the other future, cancelling its request (allowed, §14). A failed getTiles caches nothing.
- The tiles are fetched by the reference's `mapLimit`, transcribed as `min(8, n)` worker futures joined with `join_all`, each claiming the next index from a shared `AtomicUsize`:

  ```rust
  let next = AtomicUsize::new(0);
  let workers = (0..n.min(8)).map(|_| async {
      let mut done = Vec::new();
      loop {
          let i = next.fetch_add(1, Ordering::Relaxed);
          if i >= n { return done; }
          done.push((i, self.tile(&urls[i]).await));   // Some(records) or None for a failed tile; see below
      }
  });
  let slots = join_all(workers).await;
  ```

  Measured with a delaying transport, for n of 1, 3, 7, 8, 9, 20 and 100, on current-thread and multi-threaded Tokio: the peak in flight was exactly `min(8, n)`, and requests started in index order every time. `AtomicUsize` rather than `Cell` is what keeps the future `Send`. `tile(url)` checks the tile cache under the mutex when a worker reaches the URL, as the reference does, so a cached tile never becomes a request and recency is touched in the reference's order; otherwise it yields once, then awaits the transport, parses the body, and stores the tile under the mutex. The yield is a one-poll future that wakes itself, so it needs no runtime. Without it, a transport that answers on its first poll lets worker 0 store a tile, and evict, before workers 1 to 7 have looked up their URLs, where the reference's first wave of lookups all happen before any store: the port's review found six equal tiles and a budget for two fetching six on the warm search where the reference fetches four. A cached tile does not yield, so a fully cached search still completes on its first poll. A transport error or an unusable body is `None`, never an `Err`, and the search goes on (§4.4). `fetched` is the count of `Some` slots and `failed` the rest, so nothing is counted across workers.
- Assemble.

Cancellation is dropping the future (contract §11): every request future inside it is dropped with it, and with the fake transport the 8 in-flight requests were dropped and no new one started, on both runtimes. Whether the socket closes at once is the transport's business (section 4). The search's own cancellation therefore needs no rule in the tile loop, unlike Kotlin's: a dropped future runs no more code, so there is nothing to tell apart from a tile's failure. A search answered entirely from cache completes on its first poll, which the reference does and contract §11 asks for.

The CPU work runs on the thread that polls the future. Measured on the Philadelphia tiles in release builds: `serde_json` parses 112 to 127 MB/s, about 12 ms for a 2 MB tile; scoring all 15,849 records takes 39 to 43 ms for `Starbux` and 78 to 97 ms for `Reading Terminal Market`, and locating them 14 to 16 ms (two measurements). `join_all` polls every worker that is ready in the same poll, so when eight large tiles arrive together one poll parses all eight: 141 ms in the worst probe; with real reqwest, gzip and parsing over the 42 tiles, the longest single poll was 56 ms. That is more than Tokio's guidance for time between `.await`s, and it is what reqwest's own `.json()` does too. The library does not move the work to another thread itself, because doing so means `spawn_blocking`, which ties the crate to Tokio. A server that cannot afford the stall calls the blocking client from `tokio::task::spawn_blocking`, which puts the parsing, the ranking and the requests themselves on the blocking pool.

The blocking driver runs the same steps on threads, inside `std::thread::scope`: two tile lists on their own scoped threads, and a lone one on the calling thread (both are joined before the search returns, since a blocking request cannot be cancelled, so a failed getTiles still waits for its sibling, for at most `UreqTransport`'s total timeout; when both fail, the error of the first in call order is returned), then `min(8, n)` scoped worker threads claiming indices from the same kind of `AtomicUsize`, each returning its `(index, slot)` pairs through its join handle. Spawning eight threads costs microseconds next to a request. The threads race, so neither the two tile lists nor the tiles start in a fixed order, and with a budget too small for a search's tiles, which of them stay cached can differ from run to run; results do not. `CONFORMANCE.md` lists it. The blocking client has no cancellation beyond the transport's timeouts (section 8). A panic in a worker thread is re-raised in the caller when the scope joins it, so the search panics rather than counting one failed tile.

The caches' mutexes are never held across an `.await`, a transport call, or a parse.

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

Run the transcription over `Vec<u16>` from `str::encode_utf16`, both strings, never over `chars()` or bytes: the emoji example in the contract only holds for code units. The fixture's 33 cases are all in the Basic Multilingual Plane and cannot tell the difference, so the `text.rs` tests add three that can, each matching the reference to the last bit: `😀😁`/`😀😂` → 0.883333, `pizza`/`pizza 🍕` → 0.925 and `a😀`/`a` → 0.8. Three traps in a direct transcription: `max(|a|, |b|) / 2 - 1` underflows `usize` when both strings are one unit long (the fixture's `a`/`b` case panics in a debug build), so write `(a.len().max(b.len()) / 2).saturating_sub(1)`; `i - reach` underflows the same way, so write `i.saturating_sub(reach)`; and `lo..=hi` with `lo > hi` is empty in Rust (no Swift-style trap), which is what `starbux` against `bar` needs. Divide transpositions in `f64`.

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
- Snapping: `floor` and `ceil` cast with `as i64`, so the hundredths are integers from the start. Format from the integer: with `a = units.unsigned_abs()`, `format!("{}{}.{:02}", if units < 0 { "-" } else { "" }, a / 100, a % 100)`. `format!("{:.2}", units as f64 / 100.0)` gives the same strings (checked for every value from -36000 to 36000) but goes through floating point for nothing.
- `f64::clamp`, `min` and `max` are not `Math`'s. `clamp` panics when its bounds are reversed, and nothing range-checks a served box (contract §5), so one bbox-only place with south above north would panic a circle search inside `distance_to`. Transcribe `Math.min(Math.max(phiC, south), north)` as `phi_c.max(south).min(north)`, as the Kotlin and Swift ports do, which also gives the reference's answer for reversed bounds (2289581.389022535 for a box with south 10 and north 5 seen from (0, 0)). And `f64::min` and `max` return the other operand when one is NaN, where `Math.min` and `Math.max` return NaN, so haversine keeps its NaN by hand: `let s = a.sqrt(); let s = if s.is_nan() { s } else { s.min(1.0) };`. Out-of-range coordinates make `a` negative (the reference's `haversine(-89, 0, 269, 180)` is NaN), and a plain `min(1.0)` would turn that into half the earth's circumference.
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
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    serde_json::from_str(text).or_else(|e| match repair_lone_surrogates(text) {
        Some(repaired) => serde_json::from_str(&repaired),
        None => Err(e),
    })
}

/// Rewrites every `\u` escape of a lone surrogate to `\uFFFD`; `None` when there is none.
fn repair_lone_surrogates(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let hex = |i: usize| text.get(i..i + 4).and_then(|h| u16::from_str_radix(h, 16).ok());
    let (mut out, mut i, mut last, mut changed) = (String::with_capacity(text.len()), 0, 0, false);
    while i < b.len() {
        if b[i] != b'\\' { i += 1; continue; }
        if b.get(i + 1) != Some(&b'u') { i += 2; continue; }   // \\, \", \n …: skip the pair
        let Some(u) = hex(i + 2) else { i += 2; continue };
        let pair = (0xD800..0xDC00).contains(&u) && b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u')
            && hex(i + 8).is_some_and(|l| (0xDC00..0xE000).contains(&l));
        if pair { i += 12; continue; }
        if (0xD800..0xE000).contains(&u) {
            out.push_str(&text[last..i]);
            out.push_str("\\uFFFD");
            last = i + 6;
            changed = true;
        }
        i += 6;
    }
    changed.then(|| { out.push_str(&text[last..]); out })
}
```

`JSON.parse` sees text that `response.text()` produced, which drops a leading byte-order mark and turns invalid UTF-8 into U+FFFD. `serde_json::from_slice` fails on both, so decode leniently first. serde_json also rejects a lone surrogate escape (`"\ud800"`), since a Rust `String` cannot hold one, which would fail a whole tile over one string in a field nobody reads; contract §14 grants no freedom to be stricter there, and the Kotlin and Swift ports both read it. So a body that fails to parse is retried once with every lone-surrogate escape rewritten to U+FFFD, the Swift port's choice (JavaScript keeps the lone code unit; `CONFORMANCE.md` records the difference). The repair runs only after a failure, costs nothing on a good body, and was checked on a lone high and a lone low surrogate, a reversed pair, a high surrogate followed by a pair, one inside a key, and one after an escaped backslash (`"\\\ud800"`), with valid pairs and `"\\ud800"` (an escaped backslash and the text `ud800`) left alone. Two margins remain, each failing a tile where the reference carries on: a number literal that overflows a double (`1e400`), where `JSON.parse` reads Infinity, which serde_json cannot represent without `arbitrary_precision` and which section 8 leaves to the maintainer; and nesting deeper than 127 arrays or objects (serde_json's recursion limit; the Swift port's parser stops at 512). Where the two agree: `1e-400` is 0, the last of duplicate keys wins, `-0` stays negative zero, and an integer past 64 bits becomes the nearest double. One more margin applies only to coordinates sent as JSON numbers, which no garganorn tile contains (its coordinates are strings; the Philadelphia tiles hold 31,698 numbers, every one an integer, and `str::parse::<f64>` agrees with `serde_json` on all 108,862 numeric strings in them): without `float_roundtrip`, serde_json rounds some decimal literals of 17 or more significant digits to a neighbouring double. That is within the contract's 1e-6 tolerance for distances and is listed in `CONFORMANCE.md`; enabling the feature would impose it on every app (Place values, section 3).

### String comparison (contract §4.3, §8, §10)

`str`'s `Ord` compares UTF-8 bytes, which is code point order; the contract orders tile URLs, origins and the `get_place` scan's "lowest URL" by UTF-16 code units. They differ once a string holds a character above U+FFFF next to one in U+E000 to U+FFFF (`"\u{FF61}"` sorts before `"\u{10000}"` by `str` and after it by code units). Compare with `a.encode_utf16().cmp(b.encode_utf16())`. Equality needs no such care: two Rust strings are equal exactly when their code units are, and there is no canonical equivalence in `==`.

### Ranking (contract §8)

`slice::sort_by` is stable. Chain the contract's comparators with `Ordering::then_with` in the table's order, each a comparison, never a subtraction. Three traps:

- `Option<String>`'s derived `Ord` puts `None` first; the contract's `byOrigin` puts a null origin after every string. Match on the pair instead.
- `f64::total_cmp` is not the contract's order: it puts `-0.0` before `0.0`, where subtraction ties them. Use `partial_cmp`, with NaN after every number for the case it returns `None` (only out-of-range place coordinates produce a NaN distance; Kotlin records the same decision). That is not only a choice of order: since Rust 1.81 `sort_by` may panic when its comparator is not a total order, which a NaN tied with everything would make it.
- `byImportance` compares `i64`s with `cmp`, so the full range is safe; a transcription of `b - a` overflows.

### Caches (contract §10)

`TileCache` holds each tile's body as served, not its parsed records, with the keys (§4.6) of its usable records for the `get_place` scan; a tile counts as `body.len()`. Parsed into `serde_json::Value`s, a tile takes 6.0 times its body size (5.9 to 6.2 per file, measured with a counting allocator over the 42 Philadelphia tiles: 211 MB for 35 MB of bodies), so a cache of parsed tiles against a body-size budget would hold about 300 MB when the default 50 MiB is full. `ParsedTiles` keeps the parsed records of the latest search's tiles outside the budget, as contract §10 allows, as `Arc<[TileRecord]>` keyed by URL with the cache entry's generation number, so that a search uses a memoized tile only while `TileCache` still holds that same entry; fetching and recency are exactly as without the memo.

There is no ordered map in the standard library, and the cache does not need a crate for one. `TileCache` is a `HashMap<String, Entry>` where each entry carries a recency tick from a counter, plus a `BTreeMap<u64, String>` from tick to URL: a read moves the entry to a fresh tick, an insert subtracts a replaced entry's size, and eviction takes `pop_first()` until the total is within budget, which lets one large tile evict several. `find(key)` iterates the `HashMap` without touching ticks (contract §10 wants the scan not to count as use) and keeps the lowest URL by code units whose key set holds the key.

`TtlCache` takes the client's clock, `Fn() -> SystemTime`; an entry is fresh while `clock() < expires`, comparing `SystemTime`s directly, so a clock that steps backwards needs no `duration_since` error handling. The default is `SystemTime::now`, wall-clock time as the contract says, and deliberately not `Instant`: the standard library documents that whether a suspend counts as elapsed time is unspecified, and its implementations use `CLOCK_MONOTONIC` on Linux and `CLOCK_UPTIME_RAW` on macOS, neither of which advances while the machine sleeps, so a laptop that slept through the hour would keep serving an expired tile list. An insert drops expired entries first (§14), so that a client shared for the life of a process does not grow without bound under a panning map. `set` computes the expiry with `checked_add`, since `SystemTime + Duration` panics on overflow; a clock that close to the end of time caches nothing.

The caches sit behind `std::sync::Mutex`es that are never held across an `.await` or a transport call. A poisoned lock is recovered with `PoisonError::into_inner`: every critical section leaves the cache consistent before anything in it can panic, and a cache is an optimization not worth failing every later call over.

## 7. Testing

`cargo test`. Integration tests in `tests/` are a separate crate and see only the public API, so the tests of internals are unit tests beside the code, in `#[cfg(test)]` modules: `text.rs` runs `normalize.json` and `jaro-winkler.json` and ports `normalize.test.ts` and `similarity.test.ts`; `locations.rs` ports `distance.test.ts` and the contract's §6 table; `wire.rs` covers the lenient readers; `xrpc.rs` covers the query encoding, `prepare_url` and the redirect rule; `cache.rs` covers the caches. They read the fixtures with `include_str!("../tests/fixtures/…")`.

Contract §13 notes that the reference has no test of LRU eviction or of the budget, so §10 is the specification and `cache.rs` tests it directly: recency order after reads; one insert evicting several entries; a tile larger than the budget evicting every other tile and then itself; a replacement subtracting the old size; `find` choosing the lowest URL by code units on a pair where `str` order disagrees, and leaving recency alone; a memoized tile used only while its cache entry has the same generation; and a tile list fresh at `set + 3,599,999` ms and missing at exactly `set + 3,600,000`.

Fixtures are read with `include_str!`. The built-in harness has no parametrized tests, so a fixture test loops over its cases, collects every failure, and fails once with a message naming each failing case; `libtest-mimic` would give one test per case at the price of a dev-dependency and is not worth it. `tokio` is a dev-dependency only, for the async tests' runtime and its paused clock.

The fake server is one routing core behind both transport traits, so that every client-driven test runs against both clients. It:

- is configured with tilesets (slug, collections, tiles whose records are given as `serde_json::Value`s; the construction-time checks below still require well-formed records, so malformed ones are served through the raw-response override), a `tiles_for` override returning an enum with the three shapes the reference's tests use (a URL list, tiles with an overview flag, or an error and message), a `fail_tiles` list (a 500 for each), a `network_errors` list (a transport error instead of a response, for the reference's "tile fetch rejects" test), a `server` base, `go_offline()`, a raw-response override by URL that bypasses routing and validation (how `robustness.rs` serves the contract's §16 bodies), and per-URL delays, slept with `tokio::time::sleep` behind the async trait and `std::thread::sleep` behind the blocking one, with a count of the peak number of requests in flight and of requests dropped before they finished (a guard in the async face counts its own drop). The fake is a cheap `Clone` handle over shared state, so that one fake can serve two clients and be inspected afterwards, as `client.test.ts` does;
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors, and fails every request with a boxed `io::Error` when offline;
- records every request URL for the privacy tests (§12), behind a `Mutex`, since the blocking client calls it from several threads. The transport seam carries a URL and nothing else, so the method (always GET) and the body (never one) are fixed by construction; the ported tests that assert them keep their names and their remaining assertions. Headers belong to the real transports, which `transports.rs` checks;
- validates its own traffic. There is no Rust validator for atproto lexicons, so the fake implements the contract's minimum (§13) plus what `fakeServer.test.ts` asserts, as the Kotlin spec lists it: at construction, a string `slug` on every tileset, an object `value` with a string `name` on every record, and an integral `importance` when present; for requests, unknown and missing parameter names are a 400 `InvalidRequest`, `bbox` must match the §13 regular expression (written as a hand-rolled check, so the tests need no `regex` crate), and `uri` must have a scheme, a colon and no spaces. Its own responses carry the lexicon's required fields. The lexicon JSON stays vendored, with its own `SOURCE`.

Both clients through one test body: `common::Client` wraps either client behind methods that block, driving the async one on a current-thread `tokio` runtime built with `start_paused(true)`, so that the fake's delays cost no wall time, and a `both!` macro turns one body into a module `<name>` holding `async_client` and `blocking_client` tests (two names per body would need `paste` or a proc-macro). The blocking half compiles only with the `blocking` feature.

The reference's client-driven test files (`client`, `transport`, `cache`, `privacy`, `overview`, `region`, `merge`, `ranking`, `fakeServer`) map one to one onto `tests/<name>.rs`, and the three that call internal functions onto the unit tests above, each `describe` a module and each `it` a test with the same words in snake case (`TypeError` and "synchronously" become `InvalidArgument` and "before any request"), so that a reviewer can diff coverage by eye. The two source-scan suites in `client.test.ts` are not ported; their counterparts are the `--no-default-features` build in CI and `cargo deny`. `ranking.rs` drives each scenario through the client and the fake with one tile at `https://places.atgeo.org/tiles/t0.json`, with the reference's membership assertions. `tests/region.rs` adds the contract's §3 table, and the `locations.rs` unit tests its §6 table.

The `wire.rs` unit tests cover the lenient readers directly: the importance, coordinate and truthiness tables of section 6, the describe-type rules of section 3, the error-body rule, the lone-surrogate repair, and the JSON margins `CONFORMANCE.md` lists. Three integration files have no reference counterpart. `robustness.rs` covers the contract's §16 behaviours through the raw-response override. `concurrency.rs`: with 20 delayed tiles the peak in flight is 8, on both clients; dropping a search future while tiles are in flight drops every one of their requests; a search answered entirely from cache completes on its first poll (`FutureExt::now_or_never` returns `Some`), which the contract asks for and the Kotlin port cannot give; a failed getTiles caches nothing, so a retry sends a second request; and `AtgeoClient<FakeServer>` is `Send + Sync` and its `search_places` future is `Send`, asserted at compile time. `transports.rs` is next.

The default transports get tests of their own against a loopback HTTP server written on `std::net::TcpListener`, since the fake replaces them everywhere else. The file is gated on its features (`#![cfg(any(feature = "reqwest", feature = "ureq"))]`, and each transport's module on its own), and it builds each transport from `client_builder()` or `config_builder()` with short timeouts. The cases: a 4xx with a JSON error body and a 4xx with an empty body (both `Ok(HttpResponse)` with the status and body bytes, since a transport never produces `Error::Atgeo`), a same-scheme redirect, a gzipped body and an empty body labelled gzip, the body cap (exactly `max_body_bytes` is read; one byte more fails, and so does a few-kilobyte gzip body that decodes past it), a server that trickles bytes slower than the read timeout, the request headers, which must be the same set on two different requests, with `user-agent: atgeo-client-rust` and no `accept-language` (contract §12, item 5), and no `Referer` after a redirect to another host. `ReqwestTransport` adds cancellation, on the multi-threaded runtime: dropping the future mid-body closes the connection, which the loopback server observes. `UreqTransport` adds its total timeout, against a server that sends a byte per interval shorter than the read timeout; its own redirect following (ten hops followed, an eleventh refused, a redirect to `file:` refused, and a 302 carrying a 300 MiB body left unread); and the tile-URL margins `CONFORMANCE.md` lists. Both transports get a URL with a space and a tab, which must arrive as `prepare_url` makes it, and the clients' own checks (a server that is not an http or https URL refused before any request, a scheme-less tile URL a failed tile) are in `tests/client.rs`.

`examples/e2e.rs` runs both clients against a live garganorn, configured by `ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION` and `ATGEO_REGION`, the variables `scripts/e2e.ts` reads. It needs the `reqwest` and `ureq` features (`required-features`, section 2), so a build without them skips it rather than failing, and it is not part of `cargo test`.

CI: GitHub Actions. `cargo fmt --check`; `cargo clippy --all-targets --all-features -- -D warnings`; `cargo test --lib --tests` on `ubuntu-latest`, `macos-latest` and `windows-latest` with `--no-default-features`, with the defaults, with `--no-default-features --features blocking`, and with `--all-features`; `cargo test --doc --all-features`, since `cargo doc` builds documentation but does not run doctests, and the README's examples need both transports (they are `no_run`, and use `#[tokio::main(flavor = "current_thread")]`, since `tokio` is not a dependency of the crate); the `--all-features` tests with the 1.85 toolchain on the committed lockfile; a small edition-2021 app that depends on the crate, built with 1.85 (section 2); `RUSTDOCFLAGS="-D warnings" cargo doc --all-features --no-deps`; and `cargo deny check` for advisories and licences, with an allow-list of the permissive licences the tree uses (MIT, Apache-2.0, BSD-3-Clause, ISC, MIT-0, Unicode-3.0, and CDLA-Permissive-2.0 for the root certificates).

## 8. Decisions and open questions

| Decision | Choice | Why |
|---|---|---|
| Async client | runtime-agnostic: no spawning, no runtime dependency | runs on any executor; dropping the future cancels everything in it |
| Blocking client | `blocking` feature, scoped threads; ureq behind `ureq` | code without a runtime, and async code that wants all of a search off its executor (section 5); an app with its own blocking HTTP stack compiles no ureq |
| Shared core | a sans-I/O engine both drivers call | one implementation of the contract |
| Transport trait | a `Send` future from return-position `impl Trait`, boxed errors | no `async-trait` dependency; futures that multi-threaded runtimes accept; one error type for every transport |
| Place representation | `Arc<serde_json::Map>` | untouched JSON in the ecosystem's type; sharing costs 0.7 ms where deep copies cost 0.1 to 0.9 s |
| JSON | `serde_json` with no behaviour-changing features, plus a lone-surrogate repair on retry | Cargo's feature unification would impose them on the app; no tile fails over one unreadable string |
| Unicode tables | `unicode-normalization` and `unicode-properties` | `unicode-general-category`'s table is a version behind |
| Importance type | `i64`, read through `f64` | contract §1 |
| Errors | one `#[non_exhaustive]` enum, hand-written impls | one `Result` type for callers; no proc-macro dependency |
| Result types | `#[non_exhaustive]` | fields can be added in a minor release |
| Tile cache | bodies and key sets, plus the latest search's parsed tiles; LRU from a `HashMap` and a `BTreeMap` of ticks | a parsed tile is 6 times its body; no LRU crate |
| TTL clock | `SystemTime` | `Instant` may stop while a machine sleeps |
| MSRV | 1.85, edition 2024 | what reqwest, ureq and tokio already require; the MSRV-aware resolver keeps `icu` within it |
| Beta distribution | git dependency pinned to a commit | free, no publishing step, pins like the JS client |

Open:

1. `wasm32`. The transport trait requires `Send` futures, which reqwest's browser backend does not give, and the JS client already serves browsers. A `?Send` variant of the trait for `wasm32` is possible if a Rust-in-the-browser app turns up.
2. Cancellation for the blocking client. It has none beyond the transport's timeouts, which `timeout_global` bounds at 120 s a request. A cancellation token argument is easy to add and not needed until someone asks.
3. Reserving `atgeo` on crates.io before the beta ends. A name nobody holds can be taken; publishing a placeholder is the maintainer's call.
4. The size of the parsed-tile memo. It holds the latest search's tiles parsed, outside the budget: 211 MB for the 35 MB Philadelphia set, at 6 times the body size. That is the price of a free repeat search (re-parsing those tiles takes about 0.3 s); a cap measured in body bytes would bound it. Revisit with an app's numbers, together with the default budget (contract §15).
5. An offload hook for the async client's CPU work (section 5), for apps that want it off the executor without switching to the blocking client. Not until someone asks; it would mean a spawner trait, or a Tokio feature.
6. Non-BMP Jaro-Winkler cases in the shared fixture. `jaro-winkler.json` has none, so a port that compared code points, or converted only one string to code units (the Python spec's reviewer found that bug there), would pass it. The three cases section 6 adds are proposed for the fixture, so that every port runs them.
7. Number literals that overflow a double (`1e400`). They fail a tile here, where the reference and the Kotlin and Swift ports read them, and contract §14 grants no freedom for it. serde_json cannot represent one without `arbitrary_precision`, which the crate must not impose on apps. The alternatives are to accept the margin (a compliant server never sends one) or to rewrite overflowing literals on the same retry path as the lone-surrogate repair, which needs a small JSON-aware scanner. Proposed: accept it and record it in `CONFORMANCE.md`; the maintainer decides.
8. Reporting failed tiles (contract §4.4, proposed, not yet implemented). `SearchResult` gains `tile_failures: Vec<TileFailure>`, additive under `#[non_exhaustive]`. It goes on `SearchResult` rather than `TileCounts`, which is `Copy` and would lose it. `TileFailure` is `#[non_exhaustive]`: `url: String`, `kind: TileFailureKind` (a `#[non_exhaustive]` enum, `Refused`, `Status`, `Decode`, `Transport`), `status: Option<u16>`, and `error: Option<Arc<Error>>`, the crate's own `Error` (`Atgeo`, `Decoding` or `Transport` with the transport's `BoxError` inside) behind an `Arc` so the struct stays `Clone`. `PartialEq` is written by hand and ignores `error`; under `serde`, `error` is skipped and deserializes as `None`, which is the only time it is `None`. `accept_tile` keeps the error it now drops with `.ok()?`, and `wire::tile_records` returns a `DecodingError` instead of `None`. Nothing to narrow: errors are values, panics already propagate, and the cache insert cannot fail. No `log` feature: the result carries everything a log line would, and choosing `log` over `tracing` is better done when an app asks.
