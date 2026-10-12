export type PlaceValue = { [key: string]: unknown };

export interface PlaceRecord {
  uri: string;
  place: PlaceValue;
}

export interface ServiceDescription {
  did: string;
  collections: { collection: string; metadata?: string }[];
}

export type CollectionInfo = { [key: string]: unknown };

export type Region =
  | { lat: number; lon: number; radius: number }
  | { bbox: [number, number, number, number] };

export type SortMode = "fused" | "distance" | "similarity";

export interface SearchOptions {
  collection?: string;
  region: Region;
  text?: string;
  sort?: SortMode;
  signal?: AbortSignal;
}

export interface SearchHit {
  uri: string;
  place: PlaceValue;
  distance: number | null;
  score: number | null;
}

export interface SearchResult {
  places: SearchHit[];
  complete: boolean;
  summary: boolean;
  tiles: { fetched: number; failed: number };
}

export interface ClientOptions {
  server?: string;
  fetch?: typeof fetch;
  cacheBudgetBytes?: number;
}
