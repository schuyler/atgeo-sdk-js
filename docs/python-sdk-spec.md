# Python SDK specification

A Python port of `@atgeo/client`: a client for the atgeo gazetteer that searches places without telling the server what you searched for. This document covers the package, its public API, and the decisions that are specific to Python. Behaviour (what a search sends, filters, scores and returns) is defined once, for every port, in [port-contract.md](port-contract.md); this document cites it by section and does not restate it.

Status: proposal. Nothing here has been built. The recipes in section 6 were run against the fixtures at `dae7995` and the contract's worked tables on CPython 3.11, 3.12, 3.13, 3.14 and 3.15.0b4 and on PyPy 3.11, and pass: `normalize.json` 41/41 on every one of them, `jaro-winkler.json` 33/33 (worst distance from the fixture 4.8e-7), the contract's §3 bbox table, the exact expectations in `region.test.ts` and its 93-box grid test, the §6 distance table (bit-identical on x86_64 Linux), and the 12 ranking scenarios through a transcription of §4.6 to §4.9. The transport claims in section 4 were measured against a loopback server. Treat every version number below as a starting point.

## 1. Goals

- Same results as the TypeScript client for the same server answers, verified by the shared fixtures.
- Same privacy properties: search text and precise coordinates never leave the device.
- Idiomatic Python: a blocking client for scripts, notebooks and WSGI servers and an asyncio client for async servers, with the same methods, arguments and results; type hints throughout, checked with `mypy --strict`; frozen dataclasses for everything the client returns.
- No runtime dependencies. Everything the client needs is in the standard library: `urllib.request`, `json`, `unicodedata`, `concurrent.futures` and `asyncio`.

Non-goals for the first release: persistence, trio and anyio (the async client is asyncio's), a typed `Place` model, a command-line tool, and dataframe integration.

Pure Python is slower than the other ports, and a dense region shows it. Measured on CPython 3.13 over the 42 tiles places.atgeo.org serves for a 2.6 by 2.2 km box of Center City Philadelphia (`-75.18,39.94,-75.15,39.96`) (35.1 MB decoded, 15,849 records): parsing every tile takes 0.42 s, and scoring every record against the query takes 0.33 s for `Starbux` and 0.99 s for `Reading Terminal Market`. The region filter runs before scoring (contract §4.8), so a search scores only the records inside its region; those are upper bounds for that tile set. Searching the same region again with new text parses nothing (section 6, Caches). That is fine for a script, a notebook or a server answering a request, and slow for a search per keystroke. Section 8 lists what was considered and rejected for speed.

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
  transport.py          HttpResponse, Transport, AsyncTransport, UrllibTransport, AsyncUrllibTransport (section 4)
  types.py              Circle, Bbox, SortMode, SearchResult, SearchHit, PlaceRecord, PlaceLocation, the describe types
  errors.py             AtgeoError, AtgeoDecodingError
  py.typed
tests/
  fixtures/             vendored from atgeo-sdk-js fixtures/; SOURCE names the atgeo-sdk-js commit
  fixtures/lexicon/     vendored from atgeo-sdk-js test/lexicon/ as is, including its SOURCE, which names the garganorn commit
  fake_server.py        request-capturing fake, with a Transport face and an AsyncTransport face (section 7)
  test_*.py             one file per reference test file, plus test_wire.py, test_robustness.py, test_concurrency.py and test_urllib_transport.py (section 7)
examples/
  httpx_transport.py    copy-paste adapters, not dependencies (section 4)
  aiohttp_transport.py
scripts/e2e.py          end-to-end run against a live garganorn
CONFORMANCE.md          where this port reads malformed input differently from the reference (§5, §14)
```

Python 3.11 or later (`requires-python = ">=3.11"`). 3.11 is the floor because the async driver needs `asyncio.TaskGroup` and `asyncio.timeout` and the API uses `enum.StrEnum`, all new in 3.11, and because 3.10 reaches end of life this month. PyPy 3.11 is supported and tested; free-threaded CPython (3.14t) is tested, which the locking in section 5 is written for.

Build backend: `hatchling`. Development uses `uv` for environments and the lockfile, `pytest`, `ruff` for lint and format, and `mypy --strict`; none of them is a runtime dependency, and the wheel declares none.

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
        transport: Transport | None = None,          # default: UrllibTransport()
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
    # The same constructor, with transport: AsyncTransport | None (default AsyncUrllibTransport()) and
    # executor: concurrent.futures.Executor | None, where tiles are parsed and results assembled (section 5).
    async def search_places(self, region: Circle | Bbox, *, text=..., dataset=..., collection=..., sort=...) -> SearchResult: ...
    async def get_place(self, origin: str) -> PlaceRecord: ...
    async def describe_service(self) -> ServiceDescription: ...
    async def describe_tileset(self, slug: str) -> Tileset: ...
    async def aclose(self) -> None: ...
    async def __aenter__(self) -> Self: ...
    async def __aexit__(self, *exc: object) -> None: ...
```

Every argument after `region` is keyword-only, so that `search_places(region, "Starbux")` is an error rather than a guess at which string is which. Each client is safe to share and meant to be: one per server for the life of the process. `AtgeoClient` may be called from many threads at once. `AsyncAtgeoClient` may be called from many tasks at once, and holds no state bound to an event loop, so one client also works across successive `asyncio.run` calls (the test suite relies on this; section 7). Neither needs closing when it made its own default transport, since `urllib` keeps no connections open; `close()` and `aclose()` exist so that a client built around a pooled transport an app passed in can be used in a `with` block, and they close only a transport the client created.

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
    place: dict[str, Any]         # the record value as served; read-only (Place values, below)
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
    place: dict[str, Any]
    importance: int | None
    # name and location, as on SearchHit

@dataclass(frozen=True, slots=True)
class PlaceLocation:
    point: Point | None           # Point(lat, lon)
    bbox: Box | None              # Box(south, west, north, east); west > east crosses ±180
```

The describe types are frozen, keyword-only dataclasses too, every field defaulting to `None` except the three lists the lexicon requires, which default to empty:

| Class | Fields |
|---|---|
| `ServiceDescription` | `did: str \| None`, `tilesets: list[ServedTileset]` |
| `ServedTileset` | `slug: str \| None`, `collections: list[CollectionRef]` |
| `CollectionRef` | `dataset: str \| None`, `collection: str \| None` |
| `CollectionAttribution` | `dataset`, `collection`, `release`, `source`, `attribution: str \| None`, `licenses: list[str] \| None` |
| `CollectionInfo` | the `CollectionAttribution` fields, plus `record_count: int \| None`, `location_formats`, `containment_types`, `attributes: list[str] \| None`, `categories: list[CategoryCount] \| None` |
| `CategoryCount` | `value: str \| None`, `count: int \| None` |
| `Tileset` | `slug`, `published_at: str \| None`, `extent: Extent \| None`, `collections: list[CollectionInfo]`, `references: list[CollectionAttribution] \| None` |
| `Extent` | `north`, `south`, `east`, `west: str \| None` |

The dataclasses are keyword-only so that a field added later (the results will grow, as Kotlin's gained `location`, and the describe types mirror lexicons that gain fields) breaks no app that constructs one for its own tests. They are public and constructible for that reason; the client never trusts one it did not build.

Every response is read by hand from the parsed JSON (`_wire.py`), never by constructing a dataclass from a decoded dict with `**`, which would fail on an unknown key. A missing or wrong-typed field is `None`; a list the lexicon requires (`tilesets`, `collections` in both places) that is missing or not a list is empty, and an optional list is `None`; in a `list[str]` a non-string element is dropped, and in a list of objects a non-object element is dropped while an object with no readable field still maps, to an instance of `None`s; an `extent` that is not an object is `None`; unknown keys are ignored (contract §1). An `int` field (`record_count`, `count`) applies the importance rule (section 6) to the value. `published_at` and the extent's edges stay strings, as served.

Type checks in the readers use `type(v) is str` and `type(v) in (int, float)`, never `isinstance(v, (int, float))`: `bool` is a subclass of `int` in Python, so `isinstance(True, int)` holds, and the reference treats `true` as not a number (contract §1, §16). The parsed JSON contains only exact `dict`, `list`, `str`, `int`, `float`, `bool` and `None`, so the exact-type checks miss nothing.

### Place values

A place is arbitrary JSON and must be surfaced untouched (contract §1). The client surfaces the `dict` that `json.loads` built: every key in served order, every nested value, integers exact (Python's `int` is unbounded, so a place's own integers keep digits the JavaScript client rounds away; only `importance` goes through a double, section 6). An app reads a field with `hit.place.get("cuisine")`. `name` and `location` are the accessors contract §14 allows: `location` is built by the same `locate()` the ranker uses, so it cannot disagree with `distance`, and both are computed on access, so the dataclasses' fields do not change. `PlaceLocation` is not called `Location`, which collides with too many app models; its box keeps the lexicon's names.

The dict is shared, not copied. The client keeps the latest search's parsed tiles to make a repeat search cheap (section 6, Caches), and a hit's `place` is the dict in that memo, so mutating it would change what the next search over the same tiles returns. Every result type documents `place` as read-only. Copying instead was measured and rejected: `copy.deepcopy` of every place in the Philadelphia set takes 1.12 s, nearly three times as long as parsing the tiles (0.39 s), and a copier written for JSON trees still takes 0.67 s. An app that wants to change a place copies it first.

### Errors

```python
class AtgeoError(Exception):
    """A non-2xx answer from the server (contract §1)."""
    code: str        # the server's error name, or "HttpError"
    message: str
    status: int      # the HTTP status
    # str(error) is "{message} ({code})"

class AtgeoDecodingError(Exception):
    """A 2xx answer the client could not use: not JSON, or without what the call needs (contract §1).
    __cause__ is the parser's exception when there was one."""
```

Bad arguments raise `ValueError` from the top of `search_places`, in the contract's order (§3), before anything is looked up or fetched: a non-finite or out-of-range coordinate, `min_lat > max_lat`, a negative or non-finite radius, an unknown `sort`, then `similarity` with no text. A `region` that is neither a `Circle` nor a `Bbox` raises `TypeError`, Python's convention for the wrong type. This matches the JS client's `TypeError` in spirit: a programming error, kept out of `AtgeoError`'s code namespace.

`AtgeoDecodingError` is its own type, not a `ValueError` subclass, for the reason Kotlin's is not a `SerializationException`: `json.JSONDecodeError` is a `ValueError`, so an `except ValueError` written for a bad region would also swallow a garbled answer. A 2xx body that is not JSON, or has no usable body in the contract's narrow sense (§1: no `tiles` list, no `record` object, a describe body that is not an object), raises `AtgeoDecodingError` from the parser's error; nothing else about a body's shape raises. Inside a tile fetch either counts as a failed tile.

Network failures raise whatever the transport raises, unwrapped. From the default transport that is `urllib.error.URLError` and `TimeoutError` (both `OSError`s), `ssl.SSLError` (an `OSError` too), and `http.client.HTTPException` subclasses such as `IncompleteRead`, which are not `OSError`s; the README says to catch `(OSError, http.client.HTTPException)` for "no answer arrived". Cancelling the task running an `AsyncAtgeoClient` call raises `asyncio.CancelledError`.

## 4. Transport

```python
@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    body: bytes                   # decoded: no Content-Encoding left on it

class Transport(Protocol):
    def get(self, url: str) -> HttpResponse:
        """GET the URL exactly as given. Return a response for every status; raise only when no
        response arrived. Must be safe to call from several threads at once. Must not cache by default."""

class AsyncTransport(Protocol):
    async def get(self, url: str) -> HttpResponse:
        """The same, as a coroutine. Must respond to task cancellation."""

class UrllibTransport:            # Transport
    def __init__(self, *, timeout: float = 30.0, max_body_bytes: int = 32 * 1024 * 1024) -> None: ...

class AsyncUrllibTransport:       # AsyncTransport
    def __init__(self, *, timeout: float = 30.0, max_body_bytes: int = 32 * 1024 * 1024,
                 executor: concurrent.futures.Executor | None = None) -> None: ...
```

TRANSPORT-DETAILS

## 5. Concurrency and cancellation

CONCURRENCY-DETAILS

## 6. Implementing the contract in Python

Pointers for the parts where Python's defaults would give the wrong answer. Everything else is a direct transcription of the reference. Every recipe here was run as written.

### Normalization (contract §7)

```python
_WHITESPACE = frozenset(
    "\t\n\v\f\r              "
    "    　﻿"
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

The whitespace set is spelled out because none of Python's predicates is JavaScript's `\s`: `str.isspace()`, `str.split()` with no argument, `str.strip()` and `re`'s `\s` all include U+001C to U+001F and U+0085 and exclude U+FEFF (checked over every code point). Never `split()` a name or query with no argument; the contract's tokenizer is `split(" ")`.

`unicodedata` is compiled into the interpreter, so its Unicode version follows the Python version, not the operating system: 14.0 on 3.11 and PyPy 3.11, 15.0 on 3.12, 15.1 on 3.13, 16.0 on 3.14, 17.0 on 3.15. All 41 fixture cases pass on every one. CI runs the whole matrix (section 7), and a case that fails on one version only is recorded in `CONFORMANCE.md` as known skew rather than worked around.

### Jaro-Winkler (contract §7)

Python strings are sequences of code points, and the contract compares UTF-16 code units. For a string with no character above U+FFFF the two are the same sequence, so the transcription runs on the `str` itself; otherwise it runs on the string's code units:

```python
def _units(s: str) -> str | memoryview:
    if s.isascii() or max(map(ord, s)) <= 0xFFFF:
        return s
    return memoryview(s.encode("utf-16-le", "surrogatepass")).cast("H")
```

`surrogatepass` matters: JSON can carry a lone surrogate (`"\ud800"`), `json.loads` keeps it as a code point, and a plain `encode("utf-16-le")` raises on it. Both paths pass the fixture; the `str` fast path cuts the time to score the Philadelphia set by about 30% against encoding every string. Use plain lists of `bool` for the match flags. `range(lo, hi + 1)` and the reference's `while` both run zero times when `lo > hi` (`starbux` against `bar`), so Swift's trap does not apply.

Do not substitute a library. `jellyfish` 1.3.0 and `rapidfuzz` 3.14.6 both fail 3 of the 33 fixture cases (`abcvwxyz`/`cabvwxyz` among them: they halve the transpositions in integer arithmetic, which the contract warns against) and compare code points, so the emoji example scores 0.667 instead of 0.883.

### Numbers (contract §1, §3, §5, §6)

- `importance`, and the describe types' `int` fields:

  ```python
  def importance_of(v: object) -> int | None:
      if type(v) not in (int, float):     # bool, str, list, None: absent
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
      elif type(v) in (int, float):
          try:
              d = float(v)
          except OverflowError:
              return None
      else:
          return None                     # a list (contract §16), bool, None, dict
      return d if math.isfinite(d) else None
  ```

  `[0-9]`, not `\d`, which matches every Unicode digit. The `CONFORMANCE.md` margins against `parseFloat`: this port gives no location for ` 1.5`, `1.5abc`, `1e`, `1_000` and `0x10`, where `parseFloat` reads 1.5, 1.5, 1, 1 and 0. It agrees on `+1.5`, `.5`, `1.`, `-0`, `1e3`, and on `Infinity` and `NaN`, which are skipped as non-finite.
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
- Margins for `CONFORMANCE.md`, all from malformed input: nesting deeper than the parser's recursion limit raises `RecursionError` (measured: 995 levels on 3.11, 9,998 on 3.13, 40,073 on 3.14, 6,119 on PyPy 3.11; `JSON.parse` goes deeper), and an integer literal of more than 4,300 digits raises `ValueError` (CPython's integer string-conversion limit; `JSON.parse` reads Infinity). Either makes a tile fail. Do not raise the limit with `sys.set_int_max_str_digits`, which is process-wide. A JSON `-0` integer becomes `0`, where JavaScript keeps negative zero; no comparison can tell them apart.
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

- is configured with tilesets (slug, collections, tiles whose records are given as plain dicts, not as the client's own record type, so that malformed records are expressible), a `tiles_for` override returning one of the three shapes the reference's tests use (a URL list, `{"tiles": ..., "overview": ...}`, or `{"error": ..., "message": ...}`), a `fail_tiles` list, a `server` base, `go_offline()`, a `responses: dict[str, HttpResponse]` override of raw responses by URL that bypasses routing and validation (how `test_robustness.py` serves the contract's §16 bodies), and a `delays: dict[str, float]` by URL, slept with `time.sleep` on the sync face and `asyncio.sleep` on the async one, with a count of the peak number of requests in flight;
- routes `/xrpc/org.atgeo.*` and tile URLs the way `test/helpers/fakeServer.ts` does, including the dataset and collection selection errors, and raises `urllib.error.URLError("network disabled")` when offline, as the default transport would;
- records every request URL for the privacy tests (§12), in a list guarded by a `threading.Lock` along with the offline flag and the in-flight count, since the sync client calls it from several threads. The transport seam carries a URL and nothing else: the method is always GET and there is never a body, so those are fixed by construction rather than recorded; the ported tests that assert them keep their names and their remaining assertions so the by-eye diff still lines up. Headers belong to the real transport, and the urllib transport test checks them (below);
- validates its own traffic. There is no Python validator for atproto lexicons, so the fake implements the contract's minimum (§13) plus what `fakeServer.test.ts` asserts, as the Kotlin spec lists it: at construction, a string `slug` on every tileset, an object `value` with a string `name` on every record, and an integral `importance` when present (the failure message contains "integer"); for requests, unknown and missing parameter names (`dataset` and `bbox` for getTiles, `uri` for getPlace, `slug` for describeTileset) are a 400 `InvalidRequest`, `bbox` must match the §13 regular expression, and `uri` must have a scheme, a colon and no spaces, so that `not a uri` fails. Its own responses carry the lexicon's required fields. The lexicon JSON stays vendored, with its own `SOURCE`, so that a validator can be added later.

Both clients through one fixture: `client` is parametrized over `"sync"` and `"async"` and yields a thin adapter whose methods block, calling the sync client directly or the async one under `asyncio.run`. A failure names the client it happened on.

Test files map one to one onto the reference's `test/*.test.ts` as `tests/test_<name>.py`, each `describe` a class and each `it` a test function with the same words in snake case (`TypeError` and "synchronously" become `ValueError` and "before any request"), so that a reviewer can diff coverage by eye. The two source-scan suites in `client.test.ts`, `retired wire names` and `universal runtime (R9)`, are not ported; their counterpart is `test_imports.py`, which walks the AST of every module under `src/atgeo` and checks that each import is in `sys.stdlib_module_names` or the package itself. The fixture tests are parametrized with one id per case, so a failure names the case. `test_ranking.py` drives each scenario the way `ranking.test.ts` does, through the client and the fake with one tile at `https://places.atgeo.org/tiles/t0.json`, with membership assertions: each `expect.top[k].origins` within the first `k` hits, each `expect.absent` origin nowhere, and an empty `top` meaning an empty result. `test_region.py` and `test_distance.py` add the contract's worked-example tables (§3, §6).

Four files have no reference counterpart. `test_wire.py` covers the lenient readers directly: the importance, coordinate and truthiness tables of section 6, the describe-type rules of section 3, the error-body rule, and the JSON margins `CONFORMANCE.md` lists. `test_robustness.py` covers the contract's §16 behaviours through the fake's raw-response override, which the JS suite cannot, since the reference crashes on them. `test_concurrency.py`: with 20 delayed tiles the peak in flight is 8, on both clients; cancelling an async search while a tile is in flight raises `CancelledError` rather than reporting the tile as failed; a failed getTiles caches nothing, so a retry sends a second request; the async client's event loop keeps running other tasks during a search of many tiles (section 5). `test_urllib_transport.py` is next.

The default transports get tests of their own against a loopback `http.server.ThreadingHTTPServer`, since the fake replaces them everywhere else: a 4xx with a JSON error body and a 4xx with an empty body (both asserting the `HttpResponse`'s status and body bytes, since the transport does not raise `AtgeoError`), a same-scheme redirect, a gzipped body and an empty body labelled gzip, the body cap (exactly `max_body_bytes` is read; one byte more fails, and so does a few-kilobyte gzip body that decodes past it), a server that trickles bytes slower than the timeout, and the request headers, which must be the same set on two different requests. The async transport adds cancellation while a body is streaming, asserting that the awaiting task gets `CancelledError` promptly, not that the socket closes (section 5).

`scripts/e2e.py` runs both clients against a live garganorn, configured by `ATGEO_SERVER`, `ATGEO_DATASET`, `ATGEO_COLLECTION` and `ATGEO_REGION`, the variables `scripts/e2e.ts` reads. It is not part of `pytest`.

CI: GitHub Actions. A lint job runs `ruff check`, `ruff format --check` and `mypy --strict` over `src` and `tests`. The test job runs `pytest` on `ubuntu-latest` for CPython 3.11, 3.12, 3.13, 3.14 and 3.14t (free-threaded) and PyPy 3.11, because `unicodedata`'s tables travel with the interpreter (section 6), and on `macos-latest` and `windows-latest` for 3.14, where `urllib` and `ssl` differ. A packaging job builds the sdist and wheel with `uv build`, installs the wheel into an empty virtual environment, checks that nothing else was installed, and imports the package. A job on the newest CPython prerelease is allowed to fail. A job installs `httpx` and `aiohttp` and runs the transport tests against the two example adapters, so that the copy-paste code in `examples/` is known to work.

## 8. Decisions and open questions

| Decision | Choice | Why |
|---|---|---|
| Implementation | pure Python | an independent check on the contract; installs anywhere with no compiler. Python bindings over the Rust crate were considered and declined by the maintainer (2026-10-22) |
| Call styles | `AtgeoClient` and `AsyncAtgeoClient` over one sans-I/O engine | scripts, notebooks and WSGI servers block; async servers do not; one implementation of the contract serves both |
| Runtime dependencies | none | the standard library has everything the client needs; `httpx` and `aiohttp` adapters are examples, not dependencies |
| Default transports | `urllib`, run in threads for the async client | zero dependencies; the contract's no-persistence default |
| Place representation | the `dict` from `json.loads`, shared and read-only by contract | untouched JSON; copying measured at three times the cost of parsing |
| Importance type | `int`, read through `float` | contract §1's precision rule; Python `int`s do not overflow |
| Argument errors | `ValueError`, or `TypeError` for a region of the wrong type | Python convention; keeps `AtgeoError.code` the server's namespace |
| Decoding errors | `AtgeoDecodingError`, not a `ValueError` | `except ValueError` for a bad region must not catch a garbled answer |
| Ranking | a stable sort on key tuples | faster than `cmp_to_key`; no integer overflow; NaN last |
| Tile cache | bodies and key sets, plus the latest search's parsed tiles | a parsed tile is 3.5 times its body on CPython |
| TTL clock | `time.time` | monotonic clocks stop while a machine sleeps |
| Python floor | 3.11 | `TaskGroup`, `asyncio.timeout` and `StrEnum`; 3.10 reaches end of life this month |
| Beta distribution | `pip install` from GitHub by commit | free, no publishing step, pins like the JS client |

Open:

1. Speed. A dense region costs about a second per search in pure Python (section 1). If a per-keystroke search from Python turns out to matter, the candidates are an optional compiled accelerator for `normalize` and `jaro_winkler` alone, which must pass the fixtures (the two obvious libraries do not, section 6), or the bindings over the Rust crate that were declined for the first release. Proposed: wait for an app that needs it.
2. trio and anyio. The async client is asyncio's. `anyio` would make it run under trio as well, at the cost of a runtime dependency. Not until someone asks.
3. The size of the parsed-tile memo. It holds the latest search's tiles parsed, outside the budget: 123 MB for the 35 MB Philadelphia set. That is the price of a free repeat search; a cap measured in body bytes would bound it. Revisit with an app's numbers, together with the default budget (contract §15).
4. Reserving `atgeo` on PyPI before the beta ends. A name nobody holds can be taken; publishing a placeholder is the maintainer's call.
