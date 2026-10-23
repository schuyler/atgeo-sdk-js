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

  const nearby = await client.searchPlaces({ dataset, collection, region, sort: "distance" });
  expect(nearby.complete).toBe(true);
  expect(nearby.places.length).toBeGreaterThan(0);
  const distances = nearby.places.map((h) => h.distance);
  expect(
    distances.every((d, i) => typeof d === "number" && d <= region.radius && (i === 0 || d >= distances[i - 1])),
  ).toBe(true);

  const named = nearby.places.find((h) => h.origin && typeof h.place.name === "string" && h.place.name);
  expect(named).toBeDefined();
  const name = named!.place.name as string;
  const matched = await client.searchPlaces({ dataset, collection, region, text: name });
  expect(matched.places.some((h) => h.origin === named!.origin && h.score !== null)).toBe(true);

  const record = await new AtgeoClient({ server: ATGEO_SERVER }).getPlace({ origin: named!.origin as string });
  expect(record.place.name).toBe(name);
});
