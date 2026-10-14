export type PlaceValue = { [key: string]: unknown };

export interface PlaceRecord {
  origin: string;
  place: PlaceValue;
  importance: number | null;
}

export interface CollectionRef {
  dataset: string;
  collection: string;
}

export interface ServiceDescription {
  did: string;
  tilesets: { slug: string; collections: CollectionRef[] }[];
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
  categories?: { value: string; count: number }[];
  attributes?: string[];
}

export interface Tileset {
  slug: string;
  publishedAt?: string;
  extent?: { north: string; south: string; east: string; west: string };
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
  distance: number | null;
  score: number | null;
}

export interface SearchResult {
  places: SearchHit[];
  complete: boolean;
  overview: boolean;
  tiles: { fetched: number; failed: number };
}

export interface ClientOptions {
  server?: string;
  fetch?: typeof fetch;
  cacheBudgetBytes?: number;
}
