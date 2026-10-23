export type PlaceValue = { [key: string]: unknown };

export interface PlaceRecord {
  origin: string;
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
  // Called as fetch(url, { signal }). The signal carries both the caller's abort and requestTimeoutMs;
  // honouring it lets the fetch release its connection at once. The limits below apply to whatever
  // Response it returns, so an injected fetch gets them by default. A fetch that ignores the signal
  // is still cut off at the timeout, but only the caller's abort during the body read, not during
  // the wait for headers, takes effect.
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
