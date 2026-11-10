export type PlaceValue = { [key: string]: unknown };

// Where a place is, as its first usable geo point and first usable bbox (contract section 5), in the lexicon's
// field names. A box with west > east crosses the antimeridian. Frozen, with its point and bbox.
export type PlaceLocation = {
  point: { lat: number; lon: number } | null;
  bbox: { south: number; west: number; north: number; east: number } | null;
};

export interface PlaceRecord {
  origin: string;
  // The record value as served. It is frozen (shallowly) and may be the very object the tile cache holds, so
  // assigning to it, deleting from it or defining a property on it throws a TypeError in strict mode (and does
  // nothing in sloppy mode). Nested objects and arrays (locations, variants, attributes, ...) are not frozen
  // and are shared with the cache: do not change them either. For a copy you can change, use
  // structuredClone(place) (deep) or { ...place } (shallow, nested values still shared).
  place: PlaceValue;
  importance: number | null;
  // The collections the place's data comes from, as served and in served order (duplicates included); an empty
  // list when the source has none. A copy: changing it, or an entry's `licenses`, changes nothing cached.
  attribution: Attribution[];
  // The place's `name` when it is a string, else null.
  name: string | null;
  location: PlaceLocation;
}

export interface CollectionKey {
  dataset: string;
  collection: string;
}

// A credit for one collection (org.atgeo.defs#collectionAttribution), read leniently (contract section 1).
export interface Attribution extends CollectionKey {
  release?: string;
  source?: string;
  licenses?: string[];
  attribution?: string;
}

// The describe types read leniently (contract section 1): a field the server omits, or sends as the
// wrong type, is absent, so each scalar is optional. The lists the lexicons require, `tilesets` and
// `collections`, are empty when missing, never undefined.
export interface CollectionRef {
  dataset?: string;
  collection?: string;
}

export interface ServiceDescription {
  did?: string;
  // Informational: the server's tile budget.
  maxTiles?: number;
  tilesets: { slug?: string; collections: CollectionRef[] }[];
}

export interface CollectionAttribution extends CollectionRef {
  release?: string;
  source?: string;
  licenses?: string[];
  attribution?: string;
}

export interface CollectionInfo extends CollectionAttribution {
  recordCount?: number;
  locationFormats?: string[];
  containmentTypes?: string[];
  categories?: { value?: string; count?: number }[];
  attributes?: string[];
}

export interface Tileset {
  slug?: string;
  publishedAt?: string;
  extent?: { north?: string; south?: string; east?: string; west?: string };
  collections: CollectionInfo[];
  references?: CollectionAttribution[];
  overview?: { records?: number };
}

export type Region =
  | { lat: number; lon: number; radius: number }
  | { bbox: [west: number, south: number, east: number, north: number] };

export type SortMode = "fused" | "distance" | "similarity";

export interface NearbySearchOptions {
  dataset: string;
  collection?: string;
  region: Region;
  text?: string;
  sort?: SortMode;
  // With text: if no place in the region has a word match, look at everything the loaded tiles hold, which covers
  // more than the region, and answer with that if it has one. The tiles are already in hand, so this makes no
  // request and sends nothing more. `expanded` says it happened. Default false for searchNearby, true for
  // searchNearbyThenByKeyword.
  expand?: boolean;
  signal?: AbortSignal;
}

export interface KeywordSearchOptions {
  dataset: string;
  collection?: string;
  keyword: string;
  // Sent snapped outward to whole degrees. A bbox only: a circle is refused.
  region?: { bbox: [west: number, south: number, east: number, north: number] };
  signal?: AbortSignal;
}

export interface FallbackSearchOptions {
  dataset: string;
  collection?: string;
  region: Region;
  keyword: string;
  // Whether the keyword request carries the nearby region, snapped to whole degrees.
  keywordRegion: "none" | "degree";
  // As for searchNearby, but true unless you say otherwise.
  expand?: boolean;
  sort?: SortMode;
  signal?: AbortSignal;
}

export interface KeywordAutocompleteOptions {
  dataset: string;
  collection?: string;
  region?: { bbox: [west: number, south: number, east: number, north: number] };
}

export interface KeywordAutocomplete {
  // Every keyword that qualifies is sent to the server as given. A call aborts the previous call on this
  // autocompleter, which rejects with an AbortError; a keyword the server would refuse resolves empty, unsent.
  searchByKeyword(keyword: string, options?: { signal?: AbortSignal }): Promise<KeywordSearchResult>;
}

// What the server learned during one call.
export interface Disclosure {
  // The keyword was sent.
  keyword: boolean;
  // The grid, in degrees, of the finest region sent; null if none was.
  region: 0.01 | 1 | null;
}

export interface HitBase {
  origin: string | null;
  // The collection the hit belongs to, matched against the attribution of its tile (a nearby hit) or of the place
  // (a keyword hit) (contract section 8); null when none matches. Always present. A fresh object.
  collection: CollectionKey | null;
  // The record value as served. It is frozen (shallowly); a nearby hit's is the very object the tile cache holds,
  // shared by every later search over the same tile and by getPlace. Assigning to it, deleting from it or defining a
  // property on it throws a TypeError in strict mode (and does nothing in sloppy mode). Nested objects and
  // arrays (locations, variants, attributes, ...) are not frozen and are shared too: do not change them either.
  // For a copy you can change, use structuredClone(place) (deep) or { ...place } (shallow, nested values still shared).
  place: PlaceValue;
  importance: number | null;
  // The place's `name` when it is a string, else null.
  name: string | null;
  location: PlaceLocation;
}

export interface NearbyHit extends HitBase {
  via: "tiles";
  distance: number;
  score: number | null;
}

export interface KeywordHit extends HitBase {
  via: "keyword";
}

export interface NearbySearchResult {
  places: NearbyHit[];
  // True if `expand` replaced the region's places with those of the whole tile coverage; `distance` still measures
  // from the region's center, so it says how far out they are.
  expanded: boolean;
  complete: boolean;
  overview: boolean;
  tiles: { fetched: number; failed: number };
  // One entry per failed tile, in tile URL order; empty when complete.
  tileFailures: TileFailure[];
  // The union of the attribution of every tile the search used, one entry per (dataset, collection), sorted by
  // dataset then collection. Always a list. A copy: changing it changes nothing cached.
  attribution: Attribution[];
  disclosed: Disclosure;
}

export interface KeywordSearchResult {
  places: KeywordHit[];
  // The union of the attribution of every place, as in NearbySearchResult.
  attribution: Attribution[];
  disclosed: Disclosure;
}

export interface FallbackSearchResult extends Omit<NearbySearchResult, "places"> {
  places: (NearbyHit | KeywordHit)[];
}

// refused: not an absolute http(s) URL, or it carries credentials; no request was made.
// status: a non-2xx. decode: a 2xx whose body is not a usable tile payload. transport: fetch threw.
export type TileFailureKind = "refused" | "status" | "decode" | "transport";

export interface TileFailure {
  url: string;
  kind: TileFailureKind;
  // The HTTP status, for kind "status" only.
  status?: number;
  error: unknown;
}

export interface ClientOptions {
  server?: string;
  // Called as fetch(url, { signal }). The signal carries both the caller's abort and requestTimeoutMs;
  // honouring it lets the fetch release its connection at once. The limits below apply to whatever
  // Response it returns, so an injected fetch gets them by default. A fetch that ignores the signal
  // is still cut off at the timeout and at the caller's abort, which rejects with the caller's reason.
  fetch?: typeof fetch;
  cacheBudgetBytes?: number;
  // The most a response body may hold once decoded (after any gzip), in bytes. A larger body
  // fails the request with a BodyTooLargeError, which makes a tile of it a failed tile of kind
  // "transport", and the read stops as soon as the cap is passed. Default 32 MiB. Must be a
  // positive integer; the constructor throws a TypeError otherwise.
  maxBodyBytes?: number;
  // The most time one request may take, from the call to the last byte of the body, in
  // milliseconds. A request that overruns it rejects with a DOMException named "TimeoutError", so
  // a tile is a failed tile of kind "transport". A search cancelled through its signal is not
  // a timeout: it still rejects with the signal's own reason. Default 30000. Must be a positive
  // integer no larger than 2147483647; the constructor throws a TypeError otherwise.
  requestTimeoutMs?: number;
}
