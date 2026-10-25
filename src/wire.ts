import type { TileRecord } from "./cache.js";
import type {
  Attribution,
  CollectionAttribution,
  CollectionInfo,
  CollectionRef,
  PlaceValue,
  ServiceDescription,
  Tileset,
} from "./types.js";

// Lenient readers for every response body the client consumes (contract section 1). A field that is
// missing or of the wrong type is absent; a list element that cannot be read is dropped; unknown
// fields are ignored. Only a body with nothing usable throws, and it throws DecodingError.

/**
 * A 2xx response that decoded as JSON but holds nothing the client can use: a getTiles body without a
 * `tiles` array, a getPlace body without a `value` object, a describe body that is not an object.
 * Nothing else about a body's shape is an error. A body that is not JSON at all still surfaces as the
 * `SyntaxError` that `JSON.parse` throws.
 */
export class DecodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodingError";
  }
}

const unusable = (what: string): never => {
  throw new DecodingError(what);
};

/** A JSON object: not null, not an array. */
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON string; absent for anything else. */
export const readString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// 2^63: a number of this magnitude or more is absent, so exactly -2^63 is too (contract section 1).
const TWO_TO_THE_63 = 2 ** 63;

/**
 * A JSON number read as an integer: truncated toward zero, and absent unless finite and below 2^63 in
 * magnitude. Anything else, a string holding a number included, is absent. The ports truncate the same way.
 */
export function readInteger(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) >= TWO_TO_THE_63) return undefined;
  return Math.trunc(v) + 0; // + 0 turns -0, which -0.5 truncates to, into 0
}

/** Drops the keys whose value is undefined, so an absent field is a missing key. */
function present<T extends object>(o: T): T {
  for (const key of Object.keys(o) as (keyof T)[]) if (o[key] === undefined) delete o[key];
  return o;
}

// An optional list of strings: absent unless an array; elements that are not strings are dropped.
const readStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;

// An optional list of objects mapped by `read`: absent unless an array; elements that are not objects are dropped.
const readObjects = <T>(v: unknown, read: (o: Record<string, unknown>) => T): T[] | undefined =>
  Array.isArray(v) ? v.filter(isObject).map(read) : undefined;

/** A getTiles answer: the string entries of `tiles`, and `overview` by JavaScript truthiness. */
export function readTileList(body: unknown): { tiles: string[]; overview: boolean } {
  if (!isObject(body)) return unusable("getTiles body is not an object");
  if (!Array.isArray(body.tiles)) return unusable("getTiles body has no tiles array");
  return { tiles: body.tiles.filter((t): t is string => typeof t === "string"), overview: Boolean(body.overview) };
}

// Place values are handed to the app and also held by the tile cache, so they are frozen once, here, after
// parsing (and after `present`, which deletes keys): the app cannot corrupt the cache by assigning to or
// deleting from `hit.place`. The freeze is shallow; nested objects and arrays stay shared and mutable.
const freezePlace = (value: PlaceValue): PlaceValue => Object.freeze(value);

/**
 * An attribution list (contract section 1): absent unless an array. An element is kept only if it is an
 * object whose `dataset` and `collection` are both strings; each other field is read on its own. Served order
 * and duplicates are kept.
 */
export function readAttributionList(v: unknown): Attribution[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list: Attribution[] = [];
  for (const e of v) {
    if (!isObject(e) || typeof e.dataset !== "string" || typeof e.collection !== "string") continue;
    list.push(
      present({
        dataset: e.dataset,
        collection: e.collection,
        release: readString(e.release),
        source: readString(e.source),
        licenses: readStrings(e.licenses),
        attribution: readString(e.attribution),
      }),
    );
  }
  return list;
}

/** The usable records of a tile payload: `value` is an object, frozen; `uri` and `importance` are absent unless a string and a number.
 * A record that is not an object, or has no object `value`, is skipped. The payload's `attribution` is read after the records validate. */
export function readTilePayload(body: unknown): { records: TileRecord[]; attribution?: Attribution[] } {
  if (!isObject(body) || !Array.isArray(body.records)) return unusable("tile payload has no records array");
  const records: TileRecord[] = [];
  for (const r of body.records) {
    if (!isObject(r) || !isObject(r.value)) continue;
    records.push(present({ value: freezePlace(r.value), uri: readString(r.uri), importance: readInteger(r.importance) }));
  }
  return present({ records, attribution: readAttributionList(body.attribution) });
}

/** A getPlace answer's `value` (frozen, like a tile record's value), `importance` and `attribution` (empty unless an array).
 * `uri` and `url` are not read. */
export function readPlace(body: unknown): { value: PlaceValue; importance?: number; attribution: Attribution[] } {
  if (!isObject(body)) return unusable("getPlace body is not an object");
  if (!isObject(body.value)) return unusable("getPlace body has no value object");
  return present({
    value: freezePlace(body.value),
    importance: readInteger(body.importance),
    attribution: readAttributionList(body.attribution) ?? [],
  });
}

const readCollectionRef = (o: Record<string, unknown>): CollectionRef =>
  present({ dataset: readString(o.dataset), collection: readString(o.collection) });

const readAttribution = (o: Record<string, unknown>): CollectionAttribution =>
  present({
    dataset: readString(o.dataset),
    collection: readString(o.collection),
    release: readString(o.release),
    source: readString(o.source),
    licenses: readStrings(o.licenses),
    attribution: readString(o.attribution),
  });

const readCollectionInfo = (o: Record<string, unknown>): CollectionInfo =>
  present({
    ...readAttribution(o),
    recordCount: readInteger(o.recordCount),
    locationFormats: readStrings(o.locationFormats),
    containmentTypes: readStrings(o.containmentTypes),
    categories: readObjects(o.categories, (c) => present({ value: readString(c.value), count: readInteger(c.count) })),
    attributes: readStrings(o.attributes),
  });

/** A describeService answer. `tilesets`, and `collections` within one, are empty when missing. */
export function readServiceDescription(body: unknown): ServiceDescription {
  if (!isObject(body)) return unusable("describeService body is not an object");
  return present({
    did: readString(body.did),
    maxTiles: readInteger(body.maxTiles),
    tilesets:
      readObjects(body.tilesets, (t) =>
        present({ slug: readString(t.slug), collections: readObjects(t.collections, readCollectionRef) ?? [] }),
      ) ?? [],
  });
}

/** A describeTileset answer. `collections` is empty when missing. */
export function readTileset(body: unknown): Tileset {
  if (!isObject(body)) return unusable("describeTileset body is not an object");
  const { extent, overview } = body;
  return present({
    slug: readString(body.slug),
    publishedAt: readString(body.publishedAt),
    extent: isObject(extent)
      ? present({
          north: readString(extent.north),
          south: readString(extent.south),
          east: readString(extent.east),
          west: readString(extent.west),
        })
      : undefined,
    overview: isObject(overview) ? present({ records: readInteger(overview.records) }) : undefined,
    collections: readObjects(body.collections, readCollectionInfo) ?? [],
    references: readObjects(body.references, readAttribution),
  });
}
