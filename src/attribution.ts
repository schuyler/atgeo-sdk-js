import type { Attribution, CollectionKey, PlaceValue } from "./types.js";

export const collectionPrefix = (dataset: string, collection: string) => `urn:atgeo:${dataset}:${collection}:`;

// The test of contract section 4.7, shared with the hit's collection: on `value.origin` only, never the uri fallback.
export const inCollection = (value: PlaceValue, prefix: string) =>
  typeof value.origin === "string" && value.origin.startsWith(prefix);

// The first entry, in served order, whose collection the origin belongs to. A new object, never the entry.
export function collectionOf(value: PlaceValue, attribution: readonly Attribution[] | undefined): CollectionKey | null {
  for (const { dataset, collection } of attribution ?? []) {
    if (inCollection(value, collectionPrefix(dataset, collection))) return { dataset, collection };
  }
  return null;
}

export const copyEntry = (e: Attribution): Attribution => ({ ...e, ...(e.licenses && { licenses: [...e.licenses] }) });

// Fresh objects, in the same order, duplicates kept.
export const copyAttribution = (list: readonly Attribution[]): Attribution[] => list.map(copyEntry);

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

// The union of the lists, in the order given: the first entry for each (dataset, collection) wins, no fields
// merged. Sorted by dataset then collection, ordinally. Entries are copies.
export function mergeAttribution(lists: readonly (readonly Attribution[] | undefined)[]): Attribution[] {
  const seen = new Map<string, Map<string, Attribution>>();
  for (const list of lists) {
    for (const e of list ?? []) {
      let byCollection = seen.get(e.dataset);
      if (!byCollection) seen.set(e.dataset, (byCollection = new Map()));
      if (!byCollection.has(e.collection)) byCollection.set(e.collection, copyEntry(e));
    }
  }
  return [...seen.values()].flatMap((m) => [...m.values()]).sort((a, b) => cmp(a.dataset, b.dataset) || cmp(a.collection, b.collection));
}
