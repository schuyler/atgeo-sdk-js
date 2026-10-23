export type PlaceValue = { [key: string]: unknown };

export interface PlaceRecord {
  origin: string;
  // The record value as served. It is frozen (shallowly) and may be the very object the tile cache holds, so
  // assigning to it, deleting from it or defining a property on it throws a TypeError in strict mode (and does
  // nothing in sloppy mode). Nested objects and arrays (locations, variants, attributes, ...) are not frozen
  // and are shared with the cache: do not change them either. For a copy you can change, use
  // structuredClone(place) (deep) or { ...place } (shallow, nested values still shared).
  place: PlaceValue;
  importance: number | null;
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
}

export type Region =
  | { lat: number; lon: number; radius: number }
  | { bbox: [number, number, number, number] };

export type SortMode = "fused" | "distance" | "similarity";

export interface SearchOptions {
  dataset?: string;
  collection?: string;
  region: Region;
  text?: string;
  sort?: SortMode;
  signal?: AbortSignal;
}

export interface SearchHit {
  origin: string | null;
  // The record value as served. It is frozen (shallowly) and is the very object the tile cache holds, shared by
  // every later search over the same tile and by getPlace, so assigning to it, deleting from it or defining a
  // property on it throws a TypeError in strict mode (and does nothing in sloppy mode). Nested objects and
  // arrays (locations, variants, attributes, ...) are not frozen and are shared too: do not change them either.
  // For a copy you can change, use structuredClone(place) (deep) or { ...place } (shallow, nested values still shared).
  place: PlaceValue;
  importance: number | null;
  distance: number;
  score: number | null;
}

export interface SearchResult {
  places: SearchHit[];
  complete: boolean;
  overview: boolean;
  tiles: { fetched: number; failed: number };
  // One entry per failed tile, in tile URL order; empty when complete.
  tileFailures: TileFailure[];
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
  fetch?: typeof fetch;
  cacheBudgetBytes?: number;
}
