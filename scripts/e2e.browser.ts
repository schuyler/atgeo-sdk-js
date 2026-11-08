import { expect, test } from "vitest";
import { AtgeoClient, type CollectionRef } from "../src/index.js";

declare const ATGEO_SERVER: string;
declare const ATGEO_DATASET: string;
declare const ATGEO_COLLECTION: string | undefined;
declare const ATGEO_REGION: string;

const [lat, lon, radius] = ATGEO_REGION.split(",").map(Number);
const region = { lat, lon, radius };
const dataset = ATGEO_DATASET;
const collection = ATGEO_COLLECTION;
// With a collection set, the tileset must serve that collection, not just the dataset.
const wanted = (c: CollectionRef) => c.dataset === dataset && (!collection || c.collection === collection);

test("client works cross-origin against a real garganorn", async () => {
  expect(location.origin).not.toBe(new URL(ATGEO_SERVER).origin);
  const client = new AtgeoClient({ server: ATGEO_SERVER });

  const service = await client.describeService();
  const served = service.tilesets.find((t) => t.collections.some(wanted));
  expect(served?.slug).toBeTruthy();

  const tileset = await client.describeTileset(served!.slug!);
  expect(tileset.collections.some(wanted)).toBe(true);

  const nearby = await client.searchNearby({ dataset, collection, region, sort: "distance" });
  expect(nearby.complete).toBe(true);
  expect(nearby.places.length).toBeGreaterThan(0);
  const distances = nearby.places.map((h) => h.distance);
  expect(
    distances.every((d, i) => typeof d === "number" && d <= region.radius && (i === 0 || d >= distances[i - 1])),
  ).toBe(true);

  const named = nearby.places.find((h) => h.origin && typeof h.place.name === "string" && h.place.name);
  expect(named).toBeDefined();
  const name = named!.place.name as string;
  const matched = await client.searchNearby({ dataset, collection, region, text: name });
  expect(matched.places.some((h) => h.origin === named!.origin && h.score !== null)).toBe(true);

  const point = named!.location.point!;
  const cell = { bbox: [point.lon, point.lat, point.lon, point.lat] as [number, number, number, number] };
  const keyword = await client.searchByKeyword({ dataset, collection, keyword: name, region: cell });
  expect(keyword.places.length).toBeGreaterThan(0);
  expect(keyword.places.every((h) => h.via === "keyword")).toBe(true);
  expect(keyword.disclosed).toEqual({ keyword: true, region: 1 });

  const solid = await client.searchNearbyThenByKeyword({ dataset, collection, region, keyword: name, keywordRegion: "degree" });
  expect(solid.places.some((h) => h.origin === named!.origin)).toBe(true);
  expect(solid.disclosed.keyword).toBe(false);

  const fallback = await client.searchNearbyThenByKeyword({ dataset, collection, region, keyword: "zzzzqqqq", keywordRegion: "none" });
  expect(fallback.disclosed.keyword).toBe(true);

  const typing = client.autocompleteByKeyword({ dataset, collection });
  expect((await typing.searchByKeyword([...name][0])).disclosed).toEqual({ keyword: false, region: null });
  // A prefix of the name's first word of two or more characters, so it qualifies and matches the named place.
  const prefix = [...name.split(/[\s\p{P}]+/u).find((w) => [...w].length >= 2)!].slice(0, 3).join("");
  const completed = await typing.searchByKeyword(prefix);
  expect(completed.disclosed).toEqual({ keyword: true, region: null });
  expect(completed.places.length).toBeGreaterThan(0);
  expect(completed.places.every((h) => h.via === "keyword")).toBe(true);

  const record = await new AtgeoClient({ server: ATGEO_SERVER }).getPlace({ origin: named!.origin as string });
  expect(record.place.name).toBe(name);
});
