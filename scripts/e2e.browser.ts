import { expect, test } from "vitest";
import { AtgeoClient } from "../src/index.js";

declare const ATGEO_SERVER: string;
declare const ATGEO_COLLECTION: string;
declare const ATGEO_REGION: string;

const [lat, lon, radius] = ATGEO_REGION.split(",").map(Number);
const region = { lat, lon, radius };
const collection = ATGEO_COLLECTION;

test("client works cross-origin against a real garganorn", async () => {
  expect(location.origin).not.toBe(new URL(ATGEO_SERVER).origin);
  const client = new AtgeoClient({ server: ATGEO_SERVER });

  const service = await client.describeService();
  expect(service.collections.some((c) => c.collection === collection)).toBe(true);

  const info = await client.getCollectionInfo(collection);
  expect(info?.collection).toBe(collection);

  const nearby = await client.searchPlaces({ collection, region });
  expect(nearby.complete).toBe(true);
  expect(nearby.places.length).toBeGreaterThan(0);

  const named = nearby.places.find((h) => typeof h.place.name === "string" && h.place.name);
  expect(named).toBeDefined();
  const record = await new AtgeoClient({ server: ATGEO_SERVER }).getPlace({
    collection,
    rkey: named!.place.rkey as string,
  });
  expect(record.place.name).toBe(named!.place.name);
});
