# Python SDK specification

A Python port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the package, its public API, and the decisions that are specific to Python. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: proposal. Nothing here has been built. The recipes in section 6 were run against the fixtures at `dae7995` and the contract's worked tables on CPython 3.11, 3.12, 3.13, 3.14 and 3.15.0b4 and on PyPy 3.11, and pass: `normalize.json` 41/41 on every one of them, `jaro-winkler.json` 33/33 (worst distance from the fixture 4.8e-7), the contract's §3 bbox table, the exact expectations in `region.test.ts` and its 93-box grid test, the §6 distance table (bit-identical on x86_64 Linux), and the 12 ranking scenarios through a transcription of §4.6 to §4.9. The transport and concurrency claims in sections 4 and 5 were measured against a loopback server, with urllib3 2.8.0 and aiohttp 3.14.5 on CPython 3.11 to 3.14. An independent review then re-ran the recipes and the measurements; its findings are folded in, among them a Jaro-Winkler shortcut that scored 0 whenever only one string held a character above U+FFFF, redirect bodies that slipped past the body cap, and a crash on deeply nested JSON in small thread stacks. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Python: a blocking client for scripts, notebooks and WSGI servers and an asyncio client for async servers, with the same methods, arguments and results; type hints throughout, checked with `mypy --strict`; frozen dataclasses for everything the client returns.
- Few dependencies: urllib3, which has none of its own, for the blocking client's HTTP, `truststore` for the operating system's certificates, and aiohttp for the async client's HTTP, behind an `async` extra. Everything else (`json`, `unicodedata`, `threading`, `asyncio`) is the standard library.

Non-goals for the first release: persistence, trio and anyio (the async client is asyncio's), a typed `Place` model, a command-line tool, and dataframe integration.

Pure Python is slower than the other ports, and a dense region shows it. Measured on CPython 3.13 over the 42 tiles places.atgeo.org serves for a 2.6 by 2.2 km box of Center City Philadelphia (`-75.18,39.94,-75.15,39.96`) (35.1 MB decoded, 15,849 records): parsing every tile takes 0.39 to 0.42 s, and scoring every record against the query takes 0.33 s for `Starbux` and 0.99 s for `Reading Terminal Market`. The region filter runs before scoring (contract §4.8), so a search scores only the records inside its region; those are upper bounds for that tile set. Searching the same region again with new text parses nothing (section 6, Caches). That is fine for a script, a notebook or a server answering a request, and slow for a search per keystroke. Section 8 lists what was considered and rejected for speed.

## 2. Package

Repository: `schuyler/atgeo-sdk-python` (assumed; rename at will). Distribution name `atgeo` on PyPI, which is unclaimed at the time of writing; import package `atgeo`.

```
pyproject.toml
src/atgeo/
  __init__.py           the public names, re-exported
  _sync.py              AtgeoClient: the blocking driver (section 5)
  _async.py             AsyncAtgeoClient: the asyncio driver (section 5)
  _engine.py            the sans-I/O core both drivers share: caches, search planning, tile parsing, assembly (contract §4)
  _region.py            validation, centre, circle box, snapping, bbox strings (§3)
  _locations.py         locate, distance_to, in_region, record_key, dedupe (§4.6, §5, §6); the collection prefix filter (§4.7) is a line in _engine.py
  _text.py              normalize, jaro_winkler, text_score (§7)
  _rank.py              hit construction and sort keys (§8)
  _cache.py             TileCache (LRU of tile bodies), ParsedTiles, TtlCache (§10)
  _wire.py              JSON decoding and the lenient readers: tile payloads, getTiles, getPlace, the describe types, error bodies (§1, §16)
  _xrpc.py              XRPC URL building and the status check that raises AtgeoError (§1)
  transport.py          the transport building blocks: HttpResponse, Transport, AsyncTransport, BodyError, RedirectError, MAX_REDIRECTS, next_hop, CappedBody (section 4)
  _urls.py              prepare_url and the absolute-URL check every URL passes before a transport (section 4)
  _urllib3.py           Urllib3Transport, the blocking client's default
  _aiohttp.py           AiohttpTransport, the async client's default; imported only when it is used
  _body.py              CappedBody, the gzip-decoding, size-capped body reader both default transports share
  types.py              Circle, Bbox, SortMode, SearchResult, TileCounts, SearchHit, PlaceRecord, PlaceLocation, Point, Box, the describe types
  errors.py             AtgeoError, AtgeoDecodingError
  py.typed
tests/
  fixtures/             vendored from atgeo-sdk-js fixtures/; SOURCE names the atgeo-sdk-js commit
  fixtures/lexicon/     vendored from atgeo-sdk-js test/lexicon/ as is, including its SOURCE, which names the garganorn commit
  fake_server.py        request-capturing fake, with a Transport face and an AsyncTransport face (section 7)
  test_*.py             one file per reference test file, plus test_wire.py, test_robustness.py, test_concurrency.py, test_transports.py and test_imports.py (section 7)
examples/
  requests_transport.py copy-paste adapters for apps that already hold a configured session, not dependencies (section 4)
  httpx_transport.py
scripts/e2e.py          end-to-end run against a live garganorn
CONFORMANCE.md          where this port reads malformed input differently from the reference (§5, §14)
```

Python 3.11 or later (`requires-python = ">=3.11"`). 3.11 is the floor because the async driver needs `asyncio.TaskGroup` and `ExceptionGroup` and the API uses `enum.StrEnum`, all new in 3.11, and because 3.10 reaches end of life this month. PyPy 3.11 is supported and tested; free-threaded CPython (3.14t) is tested, which the locking in section 5 is written for.

Runtime dependencies, as `pyproject.toml` declares them:

```toml
dependencies = ["urllib3>=2.2", "truststore>=0.10"]

[project.optional-dependencies]
async = ["aiohttp>=3.10"]
```

urllib3 and truststore have no dependencies of their own, so `pip install atgeo` installs three packages. aiohttp brings eight more (aiohappyeyeballs, aiosignal, attrs, frozenlist, idna, multidict, propcache and yarl, several of them compiled), nine on CPython 3.11 and 3.12, where it also needs `typing_extensions`, which is why it is an extra: a script that only blocks never installs them. `AsyncAtgeoClient()` with neither the extra nor a transport of the app's own raises `ImportError` naming `atgeo[async]`. The version floors are starting points, which a CI job resolving the lowest allowed versions confirms or raises (section 7): urllib3 2.2 is the first with `HTTPResponse.read1`, which the transport needs (section 4). Section 4 says why these libraries and not others.

Build backend: `hatchling`. Development uses `uv` for environments and the lockfile, `pytest`, `ruff` for lint and format, and `mypy --strict`; none of them is a runtime dependency. Licence: BSD-3-Clause, the same `LICENSE` file as the other repositories.

Distribution during beta mirrors the JS client: not on PyPI. Install from GitHub pinned to a full commit, `pip install "atgeo @ git+https://github.com/schuyler/atgeo-sdk-python@<sha>"` (or `uv add` with the same URL). Pin a commit, not a branch: the API is still moving. Publish to PyPI as `atgeo` once the wire contract settles.

## 3. Public API

Names follow PEP 8: methods and attributes are `snake_case`, so the lexicon's `recordCount` is `record_count` here. `get_place` keeps the verb, as in the JS and Kotlin clients and the XRPC query it wraps.

```python
class AtgeoClient:
    DEFAULT_SERVER = "https://places.atgeo.org"
    DEFAULT_CACHE_BUDGET_BYTES = 50 * 1024 * 1024

    def __init__(
        self,
        server: str = DEFAULT_SERVER,
        *,
        transport: Transport | None = None,          # default: Urllib3Transport()
        cache_budget_bytes: int = DEFAULT_CACHE_BUDGET_BYTES,
        clock: Callable[[], float] = time.time,      # seconds since the epoch; for tests (section 6, Caches)
    ) -> None: ...

    def search_places(
        self,
        region: Circle | Bbox,
        *,
        text: str | None = None,
        dataset: str | None = None,
        collection: str | None = None,
        sort: SortMode | str = SortMode.FUSED,
    ) -> SearchResult: ...

    def get_place(self, origin: str) -> PlaceRecord: ...
    def describe_service(self) -> ServiceDescription: ...
    def describe_tileset(self, slug: str) -> Tileset: ...

    def close(self) -> None: ...                     # closes the transport if the client made it
    def __enter__(self) -> Self: ...
    def __exit__(self, *exc: object) -> None: ...


class AsyncAtgeoClient:
    # The same constructor, with transport: AsyncTransport | None (default AiohttpTransport(), which needs
    # the async extra).
    async def search_places(self, region: Circle | Bbox, *, text=..., dataset=..., collection=..., sort=...) -> SearchResult: ...
    async def get_place(self, origin: str) -> PlaceRecord: ...
    async def describe_service(self) -> ServiceDescription: ...
    async def describe_tileset(self, slug: str) -> Tileset: ...
    async def aclose(self) -> None: ...
    async def __aenter__(self) -> Self: ...
    async def __aexit__(self, *exc: object) -> None: ...
```

Every argument after `region` is keyword-only, so that `search_places(region, "Starbux")` is an error rather than a guess at which string is which. `server` must be an absolute http or https URL with a host, or the constructor raises `ValueError` (section 4, URLs). The optional arguments are absent only when they are `None`, as the reference's `??` has it: `dataset=""` is a dataset, sent as given, with a collection prefix of `urn:atgeo::…`. Each client is safe to share and meant to be: one per server for the life of the process, or of the event loop. `AtgeoClient` may be called from many threads at once. `AsyncAtgeoClient` may be called from many tasks at once. Its own state is not bound to an event loop, but its default transport's aiohttp session is from the first request on (aiohttp cannot use a session in another loop: measured, `RuntimeError: Event loop is closed`), so a client using the default transport belongs to the loop of its first call, and using it from another raises a `RuntimeError` that says so (section 4). A script that calls `asyncio.run` more than once makes a client inside each. The test suite's fake transport is not loop-bound, which is what lets its harness run each call under its own `asyncio.run` (section 7). Both default transports pool connections, so use a client in a `with` (or `async with`) block or call `close()` (`aclose()`) when done with it; an unclosed aiohttp session logs a warning when it is collected. A client closes only a transport it created.

```python
@dataclass(frozen=True, slots=True)
class Circle:
    lat: float
    lon: float
    radius: float                 # metres

@dataclass(frozen=True, slots=True)
class Bbox:
    min_lon: float                # degrees; min_lon > max_lon crosses the antimeridian
    min_lat: float
    max_lon: float
    max_lat: float

class SortMode(StrEnum):
    FUSED = "fused"
    DISTANCE = "distance"
    SIMILARITY = "similarity"
```

Neither region class validates in `__post_init__`: `Circle(math.nan, 0, 10)` constructs, and `search_places` rejects it (Errors, below), so that the contract's order of checks (§3) holds whichever fault a call has. `sort` takes a `SortMode` or its string value; any other string is a `ValueError` before any request.

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class SearchResult:
    places: list[SearchHit]
    complete: bool
    overview: bool
    tiles: TileCounts             # TileCounts(fetched: int, failed: int)

@dataclass(frozen=True, slots=True, kw_only=True)
class SearchHit:
    origin: str | None
    place: Mapping[str, Any]      # the record value as served, a dict at run time; read-only (Place values, below)
    importance: int | None
    distance: float               # metres
    score: float | None           # 0..1, None without text

    @property
    def name(self) -> str | None: ...         # place["name"] when that is a str
    @property
    def location(self) -> PlaceLocation: ...  # locate(place), contract §5

@dataclass(frozen=True, slots=True, kw_only=True)
class PlaceRecord:
    origin: str
    place: Mapping[str, Any]
    importance: int | None
    # name and location, as on SearchHit

@dataclass(frozen=True, slots=True, kw_only=True)
class PlaceLocation:
    point: Point | None           # Point(lat=, lon=)
    bbox: Box | None              # Box(south=, west=, north=, east=); west > east crosses ±180
```

`Point` and `Box` are keyword-only too: `Box`'s fields follow the lexicon (south, west, north, east) and `Bbox`'s the contract's region (min_lon, min_lat, max_lon, max_lat), so a positional `Bbox(*box)` would silently swap the axes. The describe types are frozen, keyword-only dataclasses as well, every field defaulting to `None` except the three lists the lexicon requires, which default to empty. Their lists are tuples, since the service description is cached and every caller gets the same object:

| Class | Fields |
|---|---|
| `ServiceDescription` | `did: str \| None`, `tilesets: tuple[ServedTileset, ...]` |
| `ServedTileset` | `slug: str \| None`, `collections: tuple[CollectionRef, ...]` |
| `CollectionRef` | `dataset: str \| None`, `collection: str \| None` |
| `CollectionAttribution` | `dataset`, `collection`, `release`, `source`, `attribution: str \| None`, `licenses: tuple[str, ...] \| None` |
| `CollectionInfo` | the `CollectionAttribution` fields, plus `record_count: int \| None`, `location_formats`, `containment_types`, `attributes: tuple[str, ...] \| None`, `categories: tuple[CategoryCount, ...] \| None` |
| `CategoryCount` | `value: str \| None`, `count: int \| None` |
| `Tileset` | `slug`, `published_at: str \| None`, `extent: Extent \| None`, `collections: tuple[CollectionInfo, ...]`, `references: tuple[CollectionAttribution, ...] \| None` |
| `Extent` | `north`, `south`, `east`, `west: str \| None` |

The result types compare by value but are not hashable, since a place is a dict. The dataclasses are keyword-only so that a field added later (the results will grow, as Kotlin's gained `location`, and the describe types mirror lexicons that gain fields) breaks no app that constructs one for its own tests. They are public and constructible for that reason; the client never trusts one it did not build.

Every response is read by hand from the parsed JSON (`_wire.py`), never by constructing a dataclass from a decoded dict with `**`, which would fail on an unknown key. A missing or wrong-typed field is `None`; a list the lexicon requires (`tilesets`, `collections` in both places) that is missing or not a list is empty, and an optional list is `None`; in a list of strings a non-string element is dropped, and in a list of objects a non-object element is dropped while an object with no readable field still maps, to an instance of `None`s; an `extent` that is not an object is `None`; unknown keys are ignored (contract §1). An `int` field (`record_count`, `count`) applies the importance rule (section 6) to the value. `published_at` and the extent's edges stay strings, as served.

Type checks in the readers use `type(v) is str` and `type(v) is int or type(v) is float`, never `isinstance(v, (int, float))`: `bool` is a subclass of `int` in Python, so `isinstance(True, int)` holds, and the reference treats `true` as not a number (contract §1, §16). The parsed JSON contains only exact `dict`, `list`, `str`, `int`, `float`, `bool` and `None`, so the exact-type checks miss nothing. Written as two `is` tests rather than `type(v) in (int, float)`, they also narrow the type for `mypy --strict`, which the tuple form does not.

### Place values

A place is arbitrary JSON and must be surfaced untouched (contract §1). The client surfaces the `dict` that `json.loads` built: every key in served order, every nested value, integers exact (Python's `int` is unbounded, so a place's own integers keep digits the JavaScript client rounds away; only `importance` goes through a double, section 6). An app reads a field with `hit.place.get("cuisine")`. `name` and `location` are the accessors contract §14 allows: `location` is built by the same `locate()` the ranker uses, so it cannot disagree with `distance`, and both are computed on access, so the dataclasses' fields do not change. `PlaceLocation` is not called `Location`, which collides with too many app models; its box keeps the lexicon's names.

The dict is shared, not copied. The client keeps the latest search's parsed tiles to make a repeat search cheap (section 6, Caches), and a hit's `place` is the dict in that memo, so mutating it would change what the next search over the same tiles returns. Every result type documents `place` as read-only, and annotates it `Mapping[str, Any]`, so that `mypy` flags a mutation in a typed app at no run-time cost. Copying instead was measured and rejected: `copy.deepcopy` of every place in the Philadelphia set takes 1.12 s, nearly three times as long as parsing the tiles (0.39 s in the same run), and a copier written for JSON trees still takes 0.67 s. An app that wants to change a place copies it first.

### Errors

```python
class AtgeoError(Exception):
    """A non-2xx answer from the server (contract §1)."""
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(code, message, status)   # all three in args, so that the error pickles
        self.code = code        # the server's error name, or "HttpError"
        self.message = message
        self.status = status    # the HTTP status
    def __str__(self) -> str:
        return f"{self.message} ({self.code})"

class AtgeoDecodingError(Exception):
    """A 2xx answer the client could not use: not JSON, or without what the call needs (contract §1).
    __cause__ is the parser's exception when there was one."""
```

Bad arguments raise `ValueError` from the top of `search_places`, in the contract's order (§3), before anything is looked up or fetched: a non-finite or out-of-range coordinate, `min_lat > max_lat`, a negative or non-finite radius, an unknown `sort`, then `similarity` with no text. A `region` that is neither a `Circle` nor a `Bbox` raises `TypeError`, Python's convention for the wrong type. This matches the JS client's `TypeError` in spirit: a programming error, kept out of `AtgeoError`'s code namespace.

`AtgeoDecodingError` is its own type, not a `ValueError` subclass, for the reason Kotlin's is not a `SerializationException`: `json.JSONDecodeError` is a `ValueError`, so an `except ValueError` written for a bad region would also swallow a garbled answer. A 2xx body that is not JSON, or has no usable body in the contract's narrow sense (§1: no `tiles` list, no `record` object, a describe body that is not an object), raises `AtgeoDecodingError` from the parser's error; nothing else about a body's shape raises. Inside a tile fetch either counts as a failed tile.

Network failures raise whatever the transport raises, unwrapped. Before a response arrives, `Urllib3Transport` raises a `MaxRetryError` whose `reason` is what went wrong (a `NewConnectionError`, a `ConnectTimeoutError`, a `ReadTimeoutError` while waiting for the headers, an `SSLError`), and `AiohttpTransport` an `aiohttp.ClientError` (connection and DNS failures are `OSError`s as well; `ServerDisconnectedError` is not) or a `TimeoutError`. urllib3's exceptions are not `OSError`s. Once a body has started, both transports raise their own `BodyError`, an `OSError`, for anything that stops it arriving whole, and `RedirectError`, an `OSError` too, for a bad or endless redirect (section 4). The README tells callers to catch `(urllib3.exceptions.HTTPError, OSError)` or `(aiohttp.ClientError, OSError)` for "no answer arrived". Cancelling the task running an `AsyncAtgeoClient` call raises `asyncio.CancelledError`; interrupting a blocking call with Ctrl-C raises `KeyboardInterrupt` (section 5).

## 4. Transport

```python
@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    body: bytes                   # decoded: no Content-Encoding left on it

class Transport(Protocol):
    def get(self, url: str) -> HttpResponse:
        """GET the URL as given, following redirects with next_hop(). Return a response for every other
        status; raise only when no response arrived whole. Must be safe to call from several threads at
        once. Must not cache, keep cookies or send credentials by default."""

class AsyncTransport(Protocol):
    async def get(self, url: str) -> HttpResponse:
        """The same, as a coroutine. Must respond to task cancellation."""

class BodyError(OSError):
    """A response arrived but its body could not be read whole: past max_body_bytes once decoded,
    cut short, stalled, or not valid gzip."""

class RedirectError(OSError):
    """A redirect to anything but an http or https URL, or more than MAX_REDIRECTS of them."""

MAX_REDIRECTS = 10
def next_hop(url: str, status: int, location: str | None) -> str | None: ...   # Redirects, below
class CappedBody: ...                                                         # The body reader, below

class Urllib3Transport:           # Transport; AtgeoClient's default
    def __init__(self, *, connect_timeout: float = 10.0, read_timeout: float = 30.0,
                 total_timeout: float = 120.0, max_body_bytes: int = 32 * 1024 * 1024,
                 ssl_context: ssl.SSLContext | None = None) -> None: ...
    def close(self) -> None: ...

class AiohttpTransport:           # AsyncTransport; AsyncAtgeoClient's default; needs atgeo[async]
    def __init__(self, *, connect_timeout: float = 10.0, read_timeout: float = 30.0,
                 max_body_bytes: int = 32 * 1024 * 1024,
                 ssl_context: ssl.SSLContext | None = None) -> None: ...
    async def aclose(self) -> None: ...
```

`HttpResponse`, the two protocols, `BodyError`, `RedirectError`, `MAX_REDIRECTS`, `next_hop` and `CappedBody` are public, in `atgeo.transport`, for apps that write a transport of their own (the examples do). The two default transports are importable from `atgeo` itself, `AiohttpTransport` lazily through a module-level `__getattr__` (PEP 562), so that `import atgeo` never imports aiohttp.

Both transports return an `HttpResponse` for every status and never raise `AtgeoError`. The conversion of a non-2xx into `AtgeoError` happens above the seam, in `_xrpc.py` (in the tile loop a non-2xx is a failed tile, never an error), so that it applies to the fake server's responses as much as to the real ones: the body is parsed with `parse_body` (section 6) inside a `try` that treats any failure as no body, `error` and `message` are each read only if they are strings, and anything missing falls back to `HttpError` and `HTTP {status}` (contract §1, §16). The body is always in hand before the status is judged. XRPC URLs are built with `urllib.parse.urlencode(params)`, which is form encoding as `URLSearchParams` does it apart from `~` and `*`, characters that decode the same either way: the value `a,b:c d&e=f#g+h%i~j*k/l` becomes `a%2Cb%3Ac+d%26e%3Df%23g%2Bh%25i~j%2Ak%2Fl`, a literal `+` as `%2B` and a space as `+` (contract §1). Parameters go in the reference's order (`dataset`, `collection`, `bbox`), and a call with none (`describeService`) keeps the reference's trailing `?`, so that a URL-keyed override in the test fake matches the same URL in every port. The tile cache measures a tile as `len(body)`, the decoded length.

### URLs

The engine checks and prepares every URL before a transport sees one, so that both transports, and an app's own, send the same bytes. `server` must be an absolute http or https URL with a host, and both constructors raise `ValueError` otherwise: urllib3 fetched a scheme-less `127.0.0.1:PORT/ok` over plain HTTP with nothing but a `FutureWarning` (measured), so `AtgeoClient(server="places.atgeo.org")` would have sent its bboxes in cleartext. A tile URL that is not an absolute http or https URL is a failed tile, on both clients, as it is in Node's `fetch`. Then every URL goes through `prepare_url`:

```python
_KEEP = frozenset(range(0x21, 0x7F))      # printable ASCII but space, % included

def prepare_url(url: str) -> str:
    """Drop tab, LF and CR; percent-encode space, other controls and non-ASCII; leave %XX alone."""
    url = url.replace("\t", "").replace("\n", "").replace("\r", "")
    return "".join(chr(b) if b in _KEEP else f"%{b:02X}" for b in url.encode("utf-8", "surrogatepass"))
```

`https://h/t/a b.json` becomes `https://h/t/a%20b.json` and `café` becomes `caf%C3%A9`, which is what the reference's WHATWG URL parsing does to those characters; a clean URL is unchanged. Without the step the transports disagreed (measured): aiohttp, told not to requote, put a raw space and raw UTF-8 on the request line, which is malformed HTTP, while urllib3 percent-encoded them, and yarl silently dropped tab, CR and LF. urllib3 still uppercases a lowercase escape (`%2c` to `%2C`), which decodes the same. The WHATWG rules the reference applies beyond these characters (a backslash read as `/`, `..` segments resolved) are not reproduced; `CONFORMANCE.md` lists both.

### Redirects

Both transports follow redirects themselves, one hop at a time, with the library's own following off (urllib3's `redirect=False`, aiohttp's `allow_redirects=False`):

```python
_REDIRECTS = frozenset({301, 302, 303, 307, 308})

def next_hop(url: str, status: int, location: str | None) -> str | None:
    if status not in _REDIRECTS or location is None:
        return None
    target = urllib.parse.urljoin(url, prepare_url(location))
    parts = urllib.parse.urlsplit(target)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise RedirectError(f"redirect to {target!r} is not an http or https URL")
    return target
```

The transport closes a 3xx response without reading its body, requests the next URL with its own headers and a proxy chosen afresh, and raises `RedirectError` when an eleventh redirect arrives. Every hop is a GET, so 303 needs no special case. Three measurements made this the design:

- The libraries read a redirect's body before following it, past any cap of ours. urllib3 2.0.7 to 2.7.0 (and 2.2, the floor) held all of it in memory (a 302 with a 200 MiB chunked body grew the process by about 400 MiB); 2.8.0 streams it away but still downloads it to the end. `requests` and `httpx` decode it in memory: a 510 KB gzip body on a 302 grew the process by 535 MiB under `requests` and by more than 569 MiB under `httpx`. Followed by the transport, a 302 with a 300 MiB body grew the process by 7 to 18 MiB, and the server had written 1 to 3 MiB of it when the connection closed, on urllib3 2.0.7 and 2.8.0 and on aiohttp 3.14.5; the transport code below, run as written, read neither the 300 MiB body nor any hop past the tenth, and refused a redirect to `file:`.
- A library following a hop does not re-check the proxy rules: with `no_proxy=127.0.0.1`, urllib3 followed a redirect to `localhost`, which should have gone through the proxy, directly.
- The libraries disagree on the details. aiohttp's `max_redirects=10` follows nine hops where urllib3 follows ten, and urllib3 reports a redirect to `file:` as `LocationValueError`, a `ValueError`, which is the confusion `AtgeoDecodingError` exists to avoid. `RedirectError` is an `OSError` on both.

Neither library adds a `Referer` on a cross-host redirect (measured), and a transport that sends only its own headers on every hop cannot.

### TLS

Both transports take an `ssl.SSLContext`. The default is `truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)`, which verifies against the operating system's trust store, as the Rust port's platform verifier and the Kotlin and Swift ports' platform stacks do. `ssl.create_default_context()` would be the dependency-free choice, but on the python.org builds for macOS it finds no root certificates until their "Install Certificates" script has been run, so a fresh install could not reach places.atgeo.org. `truststore` (MIT, pure Python, no dependencies; 0.10.5 was released this month) is the third runtime dependency. It worked with both urllib3 and aiohttp against places.atgeo.org. Whether it rejects a bad certificate, and how it behaves against the macOS and Windows stores, could not be checked where this was written, behind a proxy that re-signs every certificate, so a CI job checks them (section 7). An app with its own certificate authority passes its own context.

### Why urllib3 and aiohttp

`urllib.request` was the first candidate, since it needs no dependency at all, and was measured and rejected. It opens a new connection for every request: fetching the 42 Philadelphia tiles from places.atgeo.org eight at a time took 1.65 to 2.65 s, against 0.72 to 0.82 s for a pooled `requests.Session` and 0.50 to 0.59 s for aiohttp, and the gap grows with the round-trip time. Its default opener reads `file:` and `data:` URLs (`urlopen("file:///etc/hostname")` returns the file) and follows redirects into FTP, which matters because the server names the tile URLs. And it is process-global: any library's `install_opener()` changes what `urlopen` does (measured: a cookie jar appeared and a `Cookie` header went out).

`requests` was next. It is urllib3 underneath, plus a `Session` that is not documented as thread-safe, keeps a cookie jar by default (`Session.cookies`), which would let a server tag every later request from the client, and with `trust_env` on, as it is by default, sends credentials from `~/.netrc` (measured: an `Authorization: Basic` header, even with cookies blocked). urllib3 alone gives the pool without the session, and has no dependencies of its own. `httpx` would serve both clients from one library, but was not adopted: its last stable release is 0.28.1, from December 2024, with 1.0 still in development releases. aiohttp is the most used asyncio HTTP client, and released 3.14.5 this month. Both refuse a tile URL that is not `http` or `https` (`file:`, `data:` and `ftp:` raised `LocationValueError` or `URLSchemeUnknown` from urllib3 and `NonHttpUrlClientError` from aiohttp, measured), and the engine's check above refuses them first.

An app that already holds a configured `requests.Session` or `httpx` client passes it through one of the adapters in `examples/`, which do what the default transports do: turn the library's redirect following off and follow with `next_hop`; read raw, undecoded bytes through `CappedBody` (`stream=True` and `response.raw.stream(64 * 1024, decode_content=False)` for requests, `iter_raw()` for httpx); keep no cookies (a jar whose policy accepts none); and, for requests, set `trust_env = False` and pass proxies explicitly. CI runs the transport tests against both (section 7).

### The body reader

Both transports switch their library's own gzip decoding off, ask for gzip themselves, and feed the raw bytes as they arrive to one reader:

```python
class CappedBody:
    def __init__(self, content_encoding: str | None, max_bytes: int) -> None:
        enc = (content_encoding or "identity").strip().lower()
        if enc not in ("identity", "gzip", "x-gzip"):
            raise BodyError(f"unexpected Content-Encoding {enc!r}")
        self._dec = None if enc == "identity" else zlib.decompressobj(16 + zlib.MAX_WBITS)
        self._max, self._raw, self._out = max_bytes, 0, bytearray()

    def feed(self, chunk: bytes) -> None:
        self._raw += len(chunk)
        if self._raw > self._max:
            raise BodyError(f"body exceeds {self._max} bytes")
        if self._dec is None:
            self._out += chunk
            return
        try:
            while chunk:
                if self._dec.eof:                                   # the next gzip member
                    self._dec = zlib.decompressobj(16 + zlib.MAX_WBITS)
                self._out += self._dec.decompress(chunk, self._max + 1 - len(self._out))   # never 0, which means unlimited
                if len(self._out) > self._max:
                    raise BodyError(f"decoded body exceeds {self._max} bytes")
                chunk = self._dec.unused_data if self._dec.eof else self._dec.unconsumed_tail
        except zlib.error as e:
            raise BodyError(f"bad gzip body: {e}") from e

    def finish(self) -> bytes:
        if self._dec is not None and self._raw and not self._dec.eof:
            raise BodyError("truncated gzip body")
        return bytes(self._out)
```

The libraries' own decoders were measured and are not good enough for a body whose URL the server chose. urllib3's accepts a truncated gzip body silently, ignores trailing garbage, and passes an unrequested `br` body through still encoded; worse, `stream(amt)` without an explicit `decode_content=True` returns raw gzip for a chunked response, on every urllib3 2.x tried (2.0.7 through 2.8.0). aiohttp's also accepts a truncated gzip body silently, and its raw-byte cap never fires on a body that decodes to nothing (a 33.6 MB stream of empty stored blocks was read to the end). With decoding off in both libraries and one reader over the raw bytes, both transports accept and reject exactly the same bodies, measured with a 100,000-byte cap: a body of exactly the cap and a gzip body decoding to exactly the cap are read; one byte more, a 4,893-byte gzip body decoding to 5 MB, a truncated gzip body, trailing garbage after the gzip stream, an unrequested `br` body, a body short of its `Content-Length` and a cut chunked body are `BodyError`s; an empty body labelled gzip (with `Content-Length: 0` and chunked) is `b""`; two gzip members are concatenated, split at every byte offset; a real 2 MB tile sent gzipped and chunked is byte-identical. A 1 GiB gzip bomb against the default 32 MiB cap fails in about 0.1 s with 67 MB peak memory (about twice the cap, from `bytearray` growth and the final copy). The 32 MiB default is the Kotlin port's: the largest tiles places.atgeo.org serves are about 2 MB (contract §14). The reference's `fetch` would decode a `br`, `deflate` or `zstd` body it did not ask for; here it fails the tile, which `CONFORMANCE.md` lists.

Each transport wraps any error raised while a body is being read (a cut or short body, a stall past the read timeout, the library's protocol errors) in `BodyError`, with the library's error as its cause, so that a body that started and did not finish is a `BodyError` on both. Errors before a response arrives are the library's own, unwrapped (section 3).

### `Urllib3Transport`

One `urllib3.PoolManager(maxsize=8, retries=RETRY, ssl_context=ssl_context)` for direct requests, shared by every thread, and one `urllib3.ProxyManager` per proxy (below):

```python
RETRY = urllib3.Retry(total=None, connect=0, read=0, status=0, other=0, redirect=0, raise_on_redirect=False)

def get(self, url: str) -> HttpResponse:
    deadline = time.monotonic() + self._total_timeout
    for _ in range(MAX_REDIRECTS + 1):
        r = self._pool_for(url).request(
            "GET", url, headers={"Accept": "application/json", "Accept-Encoding": "gzip"},
            redirect=False, retries=RETRY, preload_content=False, decode_content=False,
            timeout=urllib3.Timeout(connect=self._connect_timeout, read=self._read_timeout))
        try:
            target = next_hop(url, r.status, r.headers.get("Location"))
            if target is None:
                return HttpResponse(r.status, self._read(r, deadline))
        finally:
            r.close()                     # a redirect's body is never read, and a half-read connection never pooled
            r.release_conn()
        url = target
    raise RedirectError(f"more than {MAX_REDIRECTS} redirects")

def _read(self, r: urllib3.BaseHTTPResponse, deadline: float) -> bytes:
    try:
        body = CappedBody(r.headers.get("Content-Encoding"), self._max_body_bytes)
        while chunk := r.read1(64 * 1024, decode_content=False):   # what has arrived, up to 64 KiB
            body.feed(chunk)
            if time.monotonic() > deadline:
                raise BodyError("response took longer than total_timeout")
        return body.finish()
    except urllib3.exceptions.HTTPError as e:      # a short or cut body; a stall past the read timeout
        raise BodyError(f"bad body: {e!r}") from e
```

Measured with urllib3 2.8.0 on CPython 3.11, 3.13 and 3.14, and the code above run as written on 2.2.0 and 2.8.0:

- Retries. The default `Retry(3)` retries: a read timeout reached the server four times, and contract §14 forbids retrying a tile. `RETRY` above sends a request once, and leaves redirects to the transport. (`Retry(total=0, redirect=10)`, the obvious spelling for "no retries, ten redirects", follows no redirect at all, because `total` wins.)
- `maxsize=8`. The pool otherwise keeps one connection per host and discards the rest: 200 requests from 8 threads logged 7 "Connection pool is full, discarding connection" warnings. `HTTPConnectionPool` is documented thread-safe, and the `PoolManager`'s map of pools sits behind a lock. Closing each response in `finally` still let 20 sequential requests share one connection.
- Headers: `Host`, `Accept-Encoding: gzip`, `User-Agent: python-urllib3/2.8.0` and `Accept: application/json`, the same on every request. Headers passed to `request()` replace the `PoolManager`'s own entirely, so the transport passes both of its headers on every call. Without `Accept-Encoding`, `http.client` would send `identity`.
- Every status comes back as a response with a readable body (`b""` for an empty 500); nothing is raised.
- `read1`, not `stream`. `stream(amt)` waits until it has `amt` bytes, so a body trickled a byte at a time reached the deadline check only at its end (19.8 s for a 1 s `total_timeout`); `read1` returns what has arrived and stopped it at 1.00 s. `read1` is new in urllib3 2.2, which is why the floor is 2.2 (2.1.0 and 2.0.7 lack it). It still raises `ProtocolError` on a body short of its `Content-Length` and on a cut chunked body, which `_read` turns into `BodyError`.
- Timeouts are per socket operation, even with `urllib3.Timeout(total=…)`: a body trickled over 6 s with a 1 s timeout succeeds, and a stall raises `ReadTimeoutError` after 1.00 s. The deadline checked between reads bounds a whole response at `total_timeout` plus one read timeout, which matters because the blocking client cannot be cancelled except by Ctrl-C, and a server sending a byte every 29 s would otherwise hold a search indefinitely. 120 s is far beyond a 2 MB tile on a slow link (16 s at 1 Mbit/s); the Rust port's blocking transport sets the same total.
- Proxies. A `PoolManager` ignores the proxy environment variables (with `https_proxy` pointing at a dead port the request went direct), so the transport routes each request itself. It reads `urllib.request.getproxies()` once, at construction, and for each URL takes the proxy for the URL's scheme, else the `all` entry (`ALL_PROXY`), unless `urllib.request.proxy_bypass(host)` says to go direct; the bypass check reads `no_proxy` afresh on each call. A `ProxyManager(proxy, maxsize=8, retries=RETRY, ssl_context=ssl_context)` is created per proxy on first use, under a lock. Credentials in the proxy URL go into `proxy_headers=urllib3.make_headers(proxy_basic_auth="user:password")`, because urllib3 does not read them from the URL: with `http_proxy=http://user:pass@…` the proxy received no `Proxy-Authorization` and answered 407 (measured; aiohttp sent them and got 200). A `socks4://`, `socks5://` or `socks5h://` proxy is a `ValueError` at construction, since neither library speaks SOCKS without an extra package and every request would otherwise fail. `proxy_bypass` does not understand CIDR entries in `no_proxy` (`10.0.0.0/8` did not bypass `10.1.2.3`); the README says so. Measured routes: an http URL went to the proxy as an absolute-form GET, an https URL as `CONNECT`, and a `no_proxy` host direct.
- No cookie jar and no cache: after a response with `Set-Cookie`, `max-age` and an `ETag`, the next request carried no `Cookie` and no `If-None-Match`.

### `AiohttpTransport`

```python
def _session_for_running_loop(self) -> aiohttp.ClientSession:
    loop = asyncio.get_running_loop()
    if self._session is None:
        self._loop = loop
        self._session = aiohttp.ClientSession(
            auto_decompress=False,
            cookie_jar=aiohttp.DummyCookieJar(),
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=self._connect_timeout, sock_read=self._read_timeout),
            connector=aiohttp.TCPConnector(ssl=self._ssl_context),
        )
    elif loop is not self._loop:
        raise RuntimeError("AiohttpTransport belongs to the event loop of its first request; "
                           "make one client per event loop")
    return self._session

async def get(self, url: str) -> HttpResponse:
    session = self._session_for_running_loop()
    for _ in range(MAX_REDIRECTS + 1):
        async with session.get(yarl.URL(url, encoded=True), allow_redirects=False,
                               headers={"Accept": "application/json", "Accept-Encoding": "gzip"},
                               proxy=self._proxy_for(url)) as r:
            target = next_hop(url, r.status, r.headers.get("Location"))
            if target is None:
                return HttpResponse(r.status, await self._read(r))
        url = target                      # leaving the block unread closes the redirect's connection
    raise RedirectError(f"more than {MAX_REDIRECTS} redirects")

async def _read(self, r: aiohttp.ClientResponse) -> bytes:
    try:
        body = CappedBody(r.headers.get("Content-Encoding"), self._max_body_bytes)
        async for chunk in r.content.iter_chunked(64 * 1024):
            body.feed(chunk)
        return body.finish()
    except (aiohttp.ClientError, TimeoutError) as e:   # a cut body; a stall past sock_read
        raise BodyError(f"bad body: {e!r}") from e
```

Measured with aiohttp 3.14.5 on CPython 3.11, 3.13 and 3.14:

- The session is created on the first `get()`, inside the running loop. A `ClientSession()` made with no running loop raises `RuntimeError: no running event loop`, and one reused under a second `asyncio.run` raises `RuntimeError: Event loop is closed` from deep inside aiohttp; the check above replaces that with an error that names the rule (section 3).
- `yarl.URL(url, encoded=True)`. Without it yarl requotes the URL: `bbox=1%2C2%2C3%2C4&c=a%3Ab&t=%7E%27` went out as `bbox=1,2,3,4&c=a:b&t=~'`. That is harmless for the XRPC parameters, but a tile URL is fetched as the server gave it (contract §4.4), and with `encoded=True` it went out unchanged. `prepare_url` has already removed what would make it malformed.
- Headers: `Host`, `Accept: application/json`, `Accept-Encoding: gzip` and `User-Agent: Python/3.13 aiohttp/3.14.5`, the same on every request. Setting `Accept-Encoding` replaces aiohttp's own `gzip, deflate`, which on CPython 3.14 also offers `zstd`.
- `DummyCookieJar` stores nothing and sends nothing. The default jar stored a cookie and sent it back on the next request.
- `trust_env` stays off. With it on, aiohttp read `~/.netrc` and sent `Authorization: Basic …` from it, which no tile or XRPC request should carry. Proxies come instead from the same lookup as `Urllib3Transport`'s, passed per request as `proxy=`; aiohttp sends the credentials in a proxy URL itself.
- Every status comes back without raising, its body readable.
- `total=None` replaces aiohttp's default 300-second total, for the per-operation timeouts the other ports use: a body trickled over 6 s with a 1 s `sock_read` succeeds, and a stall raises after 1.00 s, as a `BodyError` once the body has started. The async client is cancellable, so it needs no total of its own.
- Cancellation: cancelling the task mid-body or before the headers raised `CancelledError` within 0.24 to 0.75 ms, the server saw the connection closed within 1 ms, and the connection did not go back to the pool.

Any transport an app supplies must keep no response cache and no cookie jar, or accept that the contract's no-persistence default (§10, §14) no longer holds, and should send no credentials.

## 5. Concurrency and cancellation

Both clients drive the same engine. The engine owns the caches, behind one `threading.Lock` that is never held across a request or a parse, and does everything that is not I/O: it validates and plans a search (the bbox strings, the tile-list keys and which of them are cached), turns a getTiles response into a tile list, parses and stores a tile, and assembles the result (§4.5 to §4.9). Each driver supplies the requests and the concurrency.

Every thread the clients start for this work is started with an 8 MiB stack. On CPython 3.12 and 3.13, `json.loads` recurses in C and runs out of a small thread stack before Python's recursion limit catches it: with a 1 MiB stack, 8,000 levels of nested arrays (a body of about 16 KB) crashed the interpreter with a segmentation fault, where an 8 MiB stack raised `RecursionError` (measured on 3.12 and 3.13; 3.11 and 3.14 raise `RecursionError` either way). glibc gives new threads 8 MiB, but the official Alpine images of CPython build with a 1 MiB thread stack (their Dockerfiles set `THREAD_STACK_SIZE=0x100000`). `threading.stack_size()` is process-wide, so the clients set it under a module lock around each `Thread.start()` and restore the previous value.

### `AtgeoClient`

- Validate and plan in the caller's thread; an invalid argument raises `ValueError` with no request made.
- The one or two tile lists, then the tiles, are fetched by worker threads that the search starts and owns: for the tiles, `min(8, n)` daemon threads (`threading.Thread(daemon=True)`), each claiming the next index from a counter under a lock and writing that index's slot. That is the reference's `mapLimit`: URLs claimed in order, at most 8 in flight, completion order irrelevant (§4.3). A lock rather than `next()` on an `itertools.count`, so that nothing depends on the GIL under free-threaded CPython. Each worker checks the tile cache when it reaches a URL, as the reference does, so a cached tile never becomes a request and recency is touched in the reference's order; otherwise it calls the transport and parses and stores the tile. Any `Exception` from the request or the parse leaves the slot empty, a failed tile; `MemoryError` is re-raised in the caller instead, for the reason Kotlin's tile loop does not catch `Throwable`. `fetched` is the count of filled slots and `failed` the rest. For a crossing region the two tile lists are fetched on two such threads; the first failure is raised as soon as it is known, and a failed getTiles caches nothing.
- Assemble in the caller's thread.

Not `concurrent.futures.ThreadPoolExecutor`: its threads are joined when the interpreter exits, so after a Ctrl-C the process waited for every fetch in flight (measured: 8.1 s for 8-second fetches, even after `shutdown(wait=False, cancel_futures=True)`; leaving a `with ThreadPoolExecutor()` block on Ctrl-C also waited for the queued ones, 16 s). Daemon threads do not hold up the exit.

The caller waits on the workers in a loop of `join(timeout=0.1)` calls, never an untimed wait. That is what makes the blocking client cancellable, with the platform's only mechanism for it, `KeyboardInterrupt` (contract §11). Measured with the same 8-second fetches: a Ctrl-C delivered to the process interrupted the waiting thread at once however it waited, but an interrupt raised from another thread reached an untimed wait only when the wait returned, 7 to 15 s later, and a 0.1 s polling wait within 0.02 to 0.2 s. On `KeyboardInterrupt`, or any other `BaseException` while waiting, the search sets its stop flag, so that no worker claims another URL, and re-raises. Requests already in flight finish or time out on their daemon threads (`total_timeout` bounds them), and anything they store in the cache is consistent. urllib3 can do better: `response.shutdown()` from another thread aborted a body read within 1 ms (measured), but using it needs the `Transport` protocol to grow a way to abort, and is left for later (section 8). A request still waiting for its headers cannot be aborted that way at all.

Under the GIL the worker threads overlap their I/O, not their parsing; free-threaded CPython overlaps both.

### `AsyncAtgeoClient`

- Validate and plan; an invalid argument raises `ValueError` when the call is awaited, before any request.
- The one or two tile lists are fetched as tasks in an `asyncio.TaskGroup`, which cancels the sibling when one fails (allowed, §14). A `TaskGroup` raises an `ExceptionGroup` when a child fails, even a single child (measured on 3.11 and 3.14), so the driver catches it and re-raises the group's first exception with a plain `raise eg.exceptions[0]`; `raise … from None` would wipe the `__cause__` that `AtgeoDecodingError` carries. When the caller's own task is cancelled, the `TaskGroup` raises `CancelledError`, not a group (measured), and that propagates as it is.
- The tiles are fetched by `min(8, n)` worker tasks in a `TaskGroup`, each claiming the next index from a plain counter (one thread, so no lock), checking the cache when it reaches a URL, awaiting the transport, and then parsing and storing the tile on a thread (below). A worker catches `Exception` around one tile and leaves the slot empty, re-raising `MemoryError` first. That rule is enough here, where Kotlin needed a careful one: `CancelledError` is a `BaseException`, so `except Exception` never swallows the search's own cancellation (measured), and a transport's own `asyncio.timeout` raises `TimeoutError`, an `Exception` (and an `OSError`), so it is a failed tile, which is what contract §14 says a timeout is.
- Assemble on a thread too.

The parsing and the assembly run on daemon threads the client starts itself, with the 8 MiB stack above, one per job and so at most eight at a time; the awaiting coroutine waits on an `asyncio.Future` that the thread resolves through `loop.call_soon_threadsafe`. They do not go through `run_in_executor`: the loop's default executor starts its threads with the platform's default stack, and an executor passed in by an app could be a `ProcessPoolExecutor`, which fails every job (pickling the closure raised `AttributeError`, an `Exception`, so every tile would have counted as failed and the search returned nothing without an error; measured).

The threads are there to keep the event loop free. Measured with a 1 ms ticker on the loop while parsing the 42 Philadelphia tiles and then scoring for about a second: run on the loop, the ticker stalled for up to 1.3 s on every CPython version; run in a worker thread, the longest stall was 18 to 46 ms and the median 5.4 ms, the GIL's switch interval (the long stalls are single `json.loads` calls, which hold the GIL for up to 26 ms); on free-threaded 3.13t the longest was 5.0 ms and the median 0.17 ms.

Cancellation: cancelling the calling task raises `CancelledError` in it at once, and aiohttp closes the connections in flight (section 4). A parse already running on its thread runs to its end, and the tile it stores is consistent. A call answered entirely from cache still awaits its assembly thread, so from an already-cancelled task it raises `CancelledError` rather than completing; the contract allows either (§14), and tests must not assert either.

## 6. Implementing the contract in Python

Pointers for the parts where Python's defaults would give the wrong answer. Everything else is a direct transcription of the reference. Every recipe here was run as written.

### Normalization (contract §7)

```python
_WHITESPACE = frozenset(
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)

def normalize(s: str) -> str:
    folded = unicodedata.normalize("NFKD", s.lower()).lower()  # 1. lowercase, 2. NFKD, 3. lowercase again
    out: list[str] = []
    pending_space = False
    for ch in folded:
        if unicodedata.category(ch) == "Mn":                     # 4. drop Mn
            continue
        if ch in _WHITESPACE:                                    # 5. collapse and trim
            pending_space = bool(out)
            continue
        if pending_space:
            out.append(" ")
            pending_space = False
        out.append(ch)
    return "".join(out)
```

One pass over the characters does steps 4 and 5 together: a whitespace run becomes a single space only when a non-space follows it, which also trims both ends. `str.lower()` is the Unicode default full case mapping, locale-independent, with SpecialCasing's Final_Sigma condition: `ΟΔΟΣ` → `οδος`, `İ` → `i` + U+0307, `ẞ` → `ß`. It matches V8 on the fixture's abbreviations (`Α.Σ.` → `α.ς.`, `ΑΣ.Α` → `ασ.α`) and on eight more contexts tried by hand (`Ο.Α.Σ.Α.`, `ΑΣ'Α`, `ΑΣ_ΒΣ`, `ΑΣ` + U+200B + `Α`, `aΣ.b`, `ΑΣ·Α`, `ΑΣ:Α`, `ΑΣ..Α`), so unlike Swift this port needs no hand-written sigma rule. Step 3's Final_Sigma (`𝚺𝚨𝚺` → `σας`) works because the second `lower()` sees the whole string.

The whitespace set is spelled out, in escapes so that no editor or copy and paste can lose an invisible character, because none of Python's predicates is JavaScript's `\s`: `str.isspace()`, `str.split()` with no argument, `str.strip()` and `re`'s `\s` all include U+001C to U+001F and U+0085 and exclude U+FEFF (checked over every code point). Never `split()` a name or query with no argument; the contract's tokenizer is `split(" ")`.

`unicodedata` is compiled into the interpreter, so its Unicode version follows the Python version, not the operating system: 14.0 on 3.11 and PyPy 3.11, 15.0 on 3.12, 15.1 on 3.13, 16.0 on 3.14, 17.0 on 3.15. All 41 fixture cases pass on every one. CI runs the whole matrix (section 7), and a case that fails on one version only is recorded in `CONFORMANCE.md` as known skew rather than worked around.

### Jaro-Winkler (contract §7)

Python strings are sequences of code points, and the contract compares UTF-16 code units. When neither string has a character above U+FFFF the two are the same sequence, so the transcription runs on the `str`s themselves; otherwise it runs on both strings' code units. The decision is made for the pair, never for each string alone:

```python
def _units(s: str) -> list[int]:
    return memoryview(s.encode("utf-16-le", "surrogatepass")).cast("H").tolist()

def _pair(a: str, b: str) -> tuple[str, str] | tuple[list[int], list[int]]:
    both = a + b
    if both.isascii() or max(map(ord, both)) <= 0xFFFF:
        return a, b
    return _units(a), _units(b)
```

Converting each string on its own looks the same and is wrong: a BMP string stays a `str` and its partner becomes a list of `int`s, every `a[i] == b[j]` compares a one-character string with an integer and is false, and `pizza` against `pizza 🍕` scores 0.0 where the reference gives 0.925, enough to drop a place named `Pizza 🍕` from a search for `pizza`. The 33 fixture cases are all in the BMP and do not catch it, so the port's own tests add three that do: `😀😁`/`😀😂` → 0.883333 (the contract's example), `pizza`/`pizza 🍕` → 0.925 and `a😀`/`a` → 0.8, each matching the reference to the last bit. `surrogatepass` matters: JSON can carry a lone surrogate (`"\ud800"`), `json.loads` keeps it as a code point, and a plain `encode("utf-16-le")` raises on it. The `str` fast path cuts the time to score the Philadelphia set by about 30% against encoding every string. Use plain lists of `bool` for the match flags. `range(lo, hi + 1)` and the reference's `while` both run zero times when `lo > hi` (`starbux` against `bar`), so Swift's trap does not apply.

Do not substitute a library. `jellyfish` 1.3.0 and `rapidfuzz` 3.14.6 both fail 3 of the 33 fixture cases (`abcvwxyz`/`cabvwxyz` among them: they halve the transpositions in integer arithmetic, which the contract warns against) and compare code points, so the emoji example scores 0.667 instead of 0.883.

### Numbers (contract §1, §3, §5, §6)

- `importance`, and the describe types' `int` fields:

  ```python
  def importance_of(v: object) -> int | None:
      if not (type(v) is int or type(v) is float):   # bool, str, list, None: absent
          return None
      try:
          d = float(v)                    # through a double, as the contract requires
      except OverflowError:               # an integer literal past 1.8e308 (JavaScript reads Infinity)
          return None
      if not math.isfinite(d) or abs(d) >= 2.0**63:
          return None
      return int(d)                       # truncates toward zero
  ```

  Verified: `9007199254740993` → `9007199254740992`, `1.9` → 1, `-1.9` → -1, `True` → absent, `2**63` and `-2**63` → absent, `9223372036854774784` (the largest double below 2^63) exact, `10**400` → absent. `json.loads` gives an `int` for an integer literal, exact at any size, so `float(v)` both rounds like JavaScript and can overflow.
- Coordinates (§5). `float()` accepts far more than a decimal number: surrounding whitespace, Unicode spaces among it, `1_000`, non-ASCII digits (`float("١٢")` is 12.0), and `inf` and `nan` in any case. Screen a string first, then parse, then check finiteness:

  ```python
  _NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")

  def coordinate(v: object) -> float | None:
      if type(v) is str:
          if not _NUMBER.fullmatch(v):
              return None
          d = float(v)
      elif type(v) is int or type(v) is float:
          try:
              d = float(v)
          except OverflowError:
              return None
      else:
          return None                     # a list (contract §16), bool, None, dict
      return d if math.isfinite(d) else None
  ```

  `[0-9]`, not `\d`, which matches every Unicode digit. The `CONFORMANCE.md` margins against `parseFloat`: this port gives no location for ` 1.5`, `1.5 `, `1.5abc`, `1e`, `1_000` and `0x10`, where `parseFloat` reads 1.5, 1.5, 1.5, 1, 1 and 0. It agrees on `+1.5`, `.5`, `1.`, `-0`, `1e3`, and on `Infinity` and `NaN`, which are skipped as non-finite.
- `round3` (§8): Python's `round()` rounds half to even (`round(2.5)` is 2, and `round(0.0025 * 1000) / 1000` is 0.002 where the contract wants 0.003). Write the reference's half-up rule:

  ```python
  def round3(x: float) -> float:
      n = x * 1000
      f = math.floor(n)
      return (f + 1 if n - f >= 0.5 else f) / 1000
  ```

  `n - math.floor(n)` is exact in binary floating point, so this is `Math.round` without the `floor(n + 0.5)` error at 0.49999999999999994. Snapping may use `round()`: the contract's epsilon test makes its tie rule irrelevant (§3).
- Snapping: `round`, `math.floor` and `math.ceil` all return `int`, so the hundredths are integers from the start. Format from the integer, as Kotlin does: with `a = abs(units)`, `f"{'-' if units < 0 else ''}{a // 100}.{a % 100:02d}"`. `f"{units / 100:.2f}"` gives the same strings on every worked example but prints `-0.00` for a negative zero, which integer units cannot produce.
- `math.sin`, `cos`, `asin`, `atan2`, `sqrt` and `radians` call the platform's C library. The §6 table matched the contract's values exactly on x86_64 Linux; compare to 1e-6 relative anyway, containment exactly.

### Truthiness (contract §1)

`overview` follows JavaScript truthiness, which is not Python's: `[]` and `{}` are true in JavaScript and false in Python. Never `bool(value)`.

```python
_ABSENT = object()

def truthy(v: object = _ABSENT) -> bool:
    if v is _ABSENT or v is None or v is False:
        return False
    if type(v) in (int, float):
        return v != 0                     # -0.0 == 0
    if type(v) is str:
        return v != ""
    return True                           # True, and any list or dict, empty or not
```

NaN, which JavaScript also reads as false, cannot arrive: the parser rejects `NaN` (next heading).

### JSON (contract §1, §16)

`json.loads` is laxer than `JSON.parse` in one way that matters and stricter in two that do not. Decode every body the same way:

```python
def _reject_constant(name: str) -> object:
    raise ValueError(f"{name} is not JSON")

def parse_body(body: bytes) -> object:
    text = body.decode("utf-8-sig", "replace")   # drop a leading BOM; invalid UTF-8 becomes U+FFFD
    return json.loads(text, parse_constant=_reject_constant)
```

- `json.loads` accepts the literals `NaN`, `Infinity` and `-Infinity` by default; `JSON.parse` rejects the whole body. `parse_constant` restores the rejection. It is called only for those three literals, so it costs nothing on a normal body.
- `JSON.parse` sees text that `response.text()` produced, which drops a leading byte-order mark and turns invalid UTF-8 into U+FFFD. `json.loads` on `bytes` drops the BOM but raises `UnicodeDecodeError` on invalid UTF-8, and on a `str` raises on the BOM. Decoding with `utf-8-sig` and `replace` first matches the reference on both.
- Errors to catch around `parse_body`: `ValueError` (which covers `JSONDecodeError`, `UnicodeDecodeError` and the integer-length limit below) and `RecursionError`, which is a `RuntimeError`. `MemoryError` is left to fail the call, for the reason Kotlin's tile loop does not catch `Throwable`.
- Margins for `CONFORMANCE.md`, all from malformed input: nesting deeper than the parser's recursion limit raises `RecursionError` (measured on the main thread: 995 levels on 3.11, 9,998 on 3.13, 40,073 on 3.14, 6,119 on PyPy 3.11; `JSON.parse` goes deeper), in the clients' own threads too, because they have 8 MiB stacks (section 5), and an integer literal of more than 4,300 digits raises `ValueError` (CPython's integer string-conversion limit; `JSON.parse` reads Infinity). Either makes a tile fail. Do not raise the limit with `sys.set_int_max_str_digits`, which is process-wide. A JSON `-0` integer becomes `0`, where JavaScript keeps negative zero; no comparison can tell them apart.
- Where the two agree, at margins a port might get wrong: `1e400` is infinity; the last of duplicate keys wins; a lone surrogate escape is kept.

### String comparison (contract §4.3, §8, §10)

Python orders strings by code point; the contract orders tile URLs, origins and the `getPlace` scan's "lowest URL" by UTF-16 code units. They differ once a string holds a character above U+FFFF next to one in U+E000 to U+FFFF: `sorted()` puts `"｡"` before `"\U00010000"`, UTF-16 order puts it after. Sort with `key=_utf16`:

```python
def _utf16(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")   # big-endian bytes compare in code-unit order
```

Equality needs no such care: two Python strings are equal exactly when their UTF-16 encodings are, lone surrogates included, and `==` does not apply canonical equivalence (unlike Swift), so the dedupe set and the collection prefix test (`str.startswith`) use plain strings.

### Ranking (contract §8)

Every comparator in the contract's table is a comparison of one key, so the Python sort is a key sort rather than `functools.cmp_to_key` over a comparator chain. Build the key tuple in the table's order:

| Comparator | Key |
|---|---|
| `byScore` | `-round3(hit.score or 0.0)` |
| `byImportance` | `-(hit.importance or 0)` |
| `byDistance` | `(math.isnan(d), d)` with `d = hit.distance` |
| `bySpecificity` | `(math.isnan(s), s)` with `s` the hit's specificity |
| `byOrigin` | `(hit.origin is None, _utf16(hit.origin) if hit.origin is not None else b"")` |

`list.sort` is stable by the language's guarantee, so ties keep their input order without an index in the key. Python integers do not overflow, so negating `importance` is safe at any size, which is the trap the comparators set for Swift and Kotlin. `-0.0` and `0.0` compare equal, as subtraction ties them. NaN (only out-of-range place coordinates produce one) sorts after every number, the same decision Kotlin records in its `CONFORMANCE.md`; a bare float key would make the order depend on where NaN landed. The 12 ranking scenarios pass with these keys.

### Caches (contract §10)

`TileCache` holds each tile's body as served (`bytes`), not its parsed records, with the keys (§4.6) of its usable records as a `frozenset` for the `getPlace` scan; a tile counts as `len(body)`. Parsed, a tile takes 3.5 times its body size on CPython 3.13 (measured with `tracemalloc` over the Philadelphia set), so caching parsed tiles against a body-size budget would hold about 175 MB when the default 50 MiB is full; the key sets add 7.5%. `ParsedTiles` keeps the parsed records of the latest search's tiles outside the budget, as contract §10 allows, so that the same region searched with new text parses nothing; a search uses a memoized tile only while `TileCache` still holds the same entry object, so fetching and recency are exactly as without the memo.

`TileCache` is an `OrderedDict[str, _Entry]` plus a running total. A read is `move_to_end(url)`; an insert subtracts a replaced entry's size, inserts at the end, then evicts with `popitem(last=False)` until the total is within budget, which lets one large tile evict several. `find(key)` for `get_place` iterates `items()`, which does not touch the order (contract §10 wants the scan not to count as use), keeps the lowest URL by `_utf16` whose key set holds the key, and takes the first record with that key from the memo or from parsing that one body.

`TtlCache` takes the client's `clock`, a `Callable[[], float]` returning seconds; an entry is fresh while `clock() < set_at + 3600`. The default is `time.time`, wall-clock time as the contract says, and deliberately not `time.monotonic`: CPython's monotonic clock is `CLOCK_MONOTONIC` on Linux and `mach_absolute_time` on macOS, neither of which advances while the machine sleeps, so a laptop that slept through the hour would keep serving an expired tile list. `set` drops expired entries before inserting (§14), so that a client shared for the life of a process does not grow without bound under a panning map.

## 7. Testing

Framework: `pytest`, with no plugins. Fixtures load from `tests/fixtures/` by path. The async client's tests run each call through `asyncio.run`, so `pytest-asyncio` is not needed, and the client's lack of loop-bound state (section 3) is exercised by every one of them.

The fake server is one routing core with two faces, a `Transport` (`fake.transport`) and an `AsyncTransport` (`fake.async_transport`), so that every client-driven test runs against both clients. It:

- is configured with tilesets (slug, collections, tiles whose records are given as plain dicts; the construction-time checks below still require well-formed records, so malformed ones are served through the raw-response override), a `tiles_for` override returning one of the three shapes the reference's tests use (a URL list, `{"tiles": ..., "overview": ...}`, or `{"error": ..., "message": ...}`), a `fail_tiles` list, a `server` base, `go_offline()`, a `responses: dict[str, HttpResponse]` override of raw responses by URL that bypasses routing and validation (how `test_robustness.py` serves the contract's §16 bodies), and a `delays: dict[str, float]` by URL, slept with `time.sleep` on the sync face and `asyncio.sleep` on the async one, with a count of the peak number of requests in flight;
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors, and raises `ConnectionError("network disabled")` when offline, or for any URL in its `network_errors` list, which the reference's "tile fetch rejects" test needs;
- records every request URL for the privacy tests (§12), in a list guarded by a `threading.Lock` along with the offline flag and the in-flight count, since the sync client calls it from several threads. The transport seam carries a URL and nothing else: the method is always GET and there is never a body, so those are fixed by construction rather than recorded; the ported tests that assert them keep their names and their remaining assertions so the by-eye diff still lines up. Headers belong to the real transports, which `test_transports.py` checks (below);
- validates its own traffic. There is no Python validator for atproto lexicons, so the fake implements the contract's minimum (§13) plus what `fakeServer.test.ts` asserts, as the Kotlin spec lists it: at construction, a string `slug` on every tileset, an object `value` with a string `name` on every record, and an integral `importance` when present (the failure message contains "integer"); for requests, unknown and missing parameter names (`dataset` and `bbox` for getTiles, `uri` for getPlace, `slug` for describeTileset) are a 400 `InvalidRequest`, `bbox` must match the §13 regular expression, and `uri` must have a scheme, a colon and no spaces, so that `not a uri` fails. Its own responses carry the lexicon's required fields. The lexicon JSON stays vendored, with its own `SOURCE`, so that a validator can be added later.

Both clients through one fixture: `client` is parametrized over `"sync"` and `"async"` and yields a thin adapter whose methods block, calling the sync client directly or the async one under `asyncio.run`. A failure names the client it happened on.

Test files map one to one onto the reference's `test/*.test.ts` as `tests/test_<name>.py`, each `describe` a class and each `it` a test function with the same words in snake case (`TypeError` and "synchronously" become `ValueError` and "before any request"), so that a reviewer can diff coverage by eye. The two source-scan suites in `client.test.ts`, `retired wire names` and `universal runtime (R9)`, are not ported; their counterpart is `test_imports.py`, which walks the AST of every module under `src/atgeo` and checks that each import is in `sys.stdlib_module_names`, is `urllib3`, or is the package itself, except that `_aiohttp.py` may also import `aiohttp` and `yarl`; it also imports `atgeo` with `aiohttp` blocked, to prove that the blocking client never needs the extra. The fixture tests are parametrized with one id per case, so a failure names the case. `test_ranking.py` drives each scenario the way `ranking.test.ts` does, through the client and the fake with one tile at `https://places.atgeo.org/tiles/t0.json`, with membership assertions: each `expect.top[k].origins` within the first `k` hits, each `expect.absent` origin nowhere, and an empty `top` meaning an empty result. `test_region.py` and `test_distance.py` add the contract's worked-example tables (§3, §6).

Five files have no reference counterpart, `test_imports.py` above and four more. `test_wire.py` covers the lenient readers and the pure helpers directly: the importance, coordinate and truthiness tables of section 6, the describe-type rules of section 3, the error-body rule, the JSON margins `CONFORMANCE.md` lists, the three Jaro-Winkler cases outside the BMP (section 6), `prepare_url`, and `next_hop`. It also tests the caches directly, since contract §13 notes that the reference has no test of LRU eviction or of the budget, so §10 is the specification: recency order after reads; one insert evicting several entries; a tile larger than the budget evicting every other tile and then itself; a replacement subtracting the old size; `find` choosing the lowest URL by code units on a pair where `str` order disagrees, and leaving recency alone; a memoized tile used only while its cache entry is the same object; and a tile list fresh at `set + 3599.999` s and missing at exactly `set + 3600`. `test_robustness.py` covers the contract's §16 behaviours through the fake's raw-response override, which the JS suite cannot, since the reference crashes on them. `test_concurrency.py`: with 20 delayed tiles the peak in flight is 8, on both clients; cancelling an async search while a tile is in flight raises `CancelledError` rather than reporting the tile as failed; a failed getTiles caches nothing, so a retry sends a second request; the async client's event loop keeps running other tasks during a search of many tiles (section 5); interrupting a blocking search with `KeyboardInterrupt` (delivered to the waiting thread by `_thread.interrupt_main()` from a `threading.Timer`, which the test cancels in `finally`, since a late interrupt would abort the whole pytest session) returns control within a few hundred milliseconds while the fake's requests are still in flight, and no worker claims another URL afterwards. `test_transports.py` is next.

`test_transports.py` tests the default transports, and `CappedBody` on its own, against a loopback server written on raw sockets (so that it can record the request bytes, trickle a body, cut one short, and send any `Content-Encoding`), since the fake replaces the transports everywhere else. Each case runs against both transports: a 4xx with a JSON error body and a 4xx with an empty body (asserting the `HttpResponse`'s status and body bytes, since a transport never raises `AtgeoError`); a same-scheme redirect, ten hops followed and an eleventh refused, a redirect to `file:`, and a redirect carrying a 300 MiB body, which must not be read (peak memory and the bytes the server managed to write both stay small); no `Referer` on any hop; every body case in section 4's list, the cap at `max_body_bytes` included; a server that trickles bytes slower than the read timeout, and one that stalls; one request, not several, for a read timeout (no retry); the request headers, which must be the same set on two different requests and carry no `Cookie` after a response that set one; a URL with lowercase escapes and `%2C`, which `AiohttpTransport` must send byte for byte, and one with a space and a tab, which both must send as `prepare_url` makes it; a trickled body past `total_timeout` (`Urllib3Transport`); proxy routing, with `http_proxy` pointing at the loopback server and `no_proxy` naming another host, a redirect from a bypassed host to a proxied one, and a proxy URL with credentials, which must arrive as `Proxy-Authorization`; and a SOCKS proxy, refused at construction. The clients' own URL checks (a scheme-less `server` refused, a scheme-less tile URL a failed tile on both clients) are in `test_client.py`. `AiohttpTransport` adds cancellation while a body is streaming, asserting that the awaiting task gets `CancelledError` promptly and that the server sees the connection close.

`scripts/e2e.py` runs both clients against a live garganorn, configured by `ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION` and `ATGEO_REGION`, the variables `scripts/e2e.ts` reads. It is not part of `pytest`.

CI: GitHub Actions. A lint job runs `ruff check`, `ruff format --check` and `mypy --strict` over `src` and `tests`. The test job runs `pytest` on `ubuntu-latest` for CPython 3.11, 3.12, 3.13, 3.14 and 3.14t (free-threaded) and PyPy 3.11, because `unicodedata`'s tables travel with the interpreter (section 6), and on `macos-latest` and `windows-latest` for 3.14, where sockets, `ssl` and signal delivery differ; every test job installs the `async` extra. A job on CPython 3.11 resolves the lowest versions the floors allow and runs the suite, so that `urllib3>=2.2`, `truststore>=0.10` and `aiohttp>=3.10` are claims CI checks. It installs the package with `uv pip install --resolution lowest-direct ".[async]"` and the test tools in a separate step, since the resolution mode applies to every requirement on the command line (it chose pytest 2.0.0, which does not build), and it runs on 3.11 because aiohttp 3.10.0 has no wheels for 3.13 or 3.14. A packaging job builds the sdist and wheel with `uv build`, installs the wheel into an empty virtual environment, checks that the only other packages installed are urllib3 and truststore, then installs `atgeo[async]` and checks that the additions are the packages aiohttp's own metadata requires on that Python (computed, not listed: it differs between 3.12 and 3.13), and imports the package each time. A job on the newest CPython prerelease is allowed to fail. A job installs `requests` and `httpx` and runs the transport tests against the two example adapters, so that the copy-paste code in `examples/` is known to work. On `macos-latest` and `windows-latest`, a smoke test fetches `describeService` from places.atgeo.org through both default transports and fails to connect to an expired and a self-signed certificate (badssl.com's), which checks truststore against those platforms' stores; it is the one test that needs the network.

## 8. Decisions and open questions

| Decision | Choice | Why |
|---|---|---|
| Implementation | pure Python | an independent check on the contract; installs anywhere with no compiler. Python bindings over the Rust crate were considered and declined by the maintainer (2026-10-22) |
| Call styles | `AtgeoClient` and `AsyncAtgeoClient` over one sans-I/O engine | scripts, notebooks and WSGI servers block; async servers do not; one implementation of the contract serves both |
| Runtime dependencies | urllib3; aiohttp behind the `async` extra | pooled connections, two to three times faster than `urllib.request` on a real search; urllib3 has no dependencies of its own; a blocking-only install never pulls in aiohttp's compiled tree |
| Default transports | a `urllib3.PoolManager` and an aiohttp session, with the libraries' redirect following and gzip decoding off, one capped reader, and one redirect helper | no retries, no cookies, no `.netrc`; a redirect's body is never read; both transports accept and reject the same bodies and send the same bytes |
| URLs | checked and prepared once, above the transports | a scheme-less server would have gone over cleartext; the transports disagreed on spaces and non-ASCII |
| TLS roots | `truststore`, the operating system's store | python.org's macOS builds have no roots until a script is run; the Rust port uses the platform's store too |
| Not `urllib.request`, `requests` or `httpx` | rejected | measured: a connection per request and `file:` URLs; a session with a cookie jar and `.netrc`; and httpx has had no stable release since December 2024 |
| Blocking concurrency | daemon worker threads, waited on in 0.1 s slices | Ctrl-C returns control and the process can exit; `ThreadPoolExecutor` joins its threads at exit |
| Async CPU work | daemon threads the client starts, with 8 MiB stacks | parsing and ranking on the loop stalled it for 1.3 s; a 1 MiB stack let deep JSON crash CPython 3.12 and 3.13; an app's `ProcessPoolExecutor` would have failed every tile silently |
| Place representation | the `dict` from `json.loads`, shared and read-only by contract | untouched JSON; copying measured at three times the cost of parsing |
| Importance type | `int`, read through `float` | contract §1's precision rule; Python `int`s do not overflow |
| Argument errors | `ValueError`, or `TypeError` for a region of the wrong type | Python convention; keeps `AtgeoError.code` the server's namespace |
| Decoding errors | `AtgeoDecodingError`, not a `ValueError` | `except ValueError` for a bad region must not catch a garbled answer |
| Ranking | a stable sort on key tuples | faster than `cmp_to_key`; no integer overflow; NaN last |
| Tile cache | bodies and key sets, plus the latest search's parsed tiles | a parsed tile is 3.5 times its body on CPython |
| TTL clock | `time.time` | monotonic clocks stop while a machine sleeps |
| Python floor | 3.11 | `TaskGroup`, `ExceptionGroup` and `StrEnum`; 3.10 reaches end of life this month |
| Beta distribution | `pip install` from GitHub by commit | free, no publishing step, pins like the JS client |

Open:

1. Speed. A dense region costs about a second per search in pure Python (section 1). If a per-keystroke search from Python turns out to matter, the candidates are an optional compiled accelerator for `normalize` and `jaro_winkler` alone, which must pass the fixtures (the two obvious libraries do not, section 6), or the bindings over the Rust crate that were declined for the first release. Proposed: wait for an app that needs it.
2. trio and anyio. The async client is asyncio's, and so is aiohttp. Supporting trio would mean `anyio` and an HTTP library that runs on it. Not until someone asks.
3. Aborting a blocking search's requests on Ctrl-C. It stops claiming URLs at once, but the requests in flight run on until they finish or time out. urllib3's `response.shutdown()` can abort a body read from another thread within 1 ms; using it needs the `Transport` protocol to grow an abort method.
4. The size of the parsed-tile memo. It holds the latest search's tiles parsed, outside the budget: 123 MB for the 35 MB Philadelphia set. That is the price of a free repeat search; a cap measured in body bytes would bound it. Revisit with an app's numbers, together with the default budget (contract §15).
5. Non-BMP Jaro-Winkler cases in the shared fixture. `jaro-winkler.json` has none, so the bug section 6 describes passes it; the three cases this port tests are proposed for the fixture, so that every port runs them.
6. Stale pooled connections. With no retries, a request sent on a keep-alive connection the server has just closed fails, and inside a search that is a failed tile. Retrying a GET that never reached the server is not retrying a tile, but telling the two apart needs care; revisit if failed tiles show up in practice.
7. Reserving `atgeo` on PyPI before the beta ends. A name nobody holds can be taken; publishing a placeholder is the maintainer's call.
