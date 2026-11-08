import assert from "node:assert/strict";
import { AtgeoClient, type CollectionRef } from "../src/index.js";

const server = process.env.ATGEO_SERVER ?? "http://localhost:8000";
const dataset = process.env.ATGEO_DATASET ?? "openstreetmap.org";
const collection = process.env.ATGEO_COLLECTION;
// With a collection set, the tileset must serve that collection, not just the dataset.
const wanted = (c: CollectionRef) => c.dataset === dataset && (!collection || c.collection === collection);
// "lat,lon,radius" in meters; the default is Manchester, NH, inside the local OSM New Hampshire tileset.
const [lat, lon, radius] = (process.env.ATGEO_REGION ?? "43.0,-71.45,3000").split(",").map(Number);
const region = { lat, lon, radius };

const client = new AtgeoClient({ server });
const log = (step: string, detail: string) => console.log(`ok  ${step}: ${detail}`);

const service = await client.describeService();
const served = service.tilesets.find((t) => t.collections.some(wanted));
assert(served, `${dataset}${collection ? `/${collection}` : ""} not served`);
log("describeService", `${service.did}, ${service.tilesets.length} tileset(s)`);

assert(served.slug, "the served tileset has no slug");
const tileset = await client.describeTileset(served.slug);
assert(tileset.collections.some(wanted), "describeTileset does not list the dataset and collection");
log("describeTileset", `${tileset.slug}, ${tileset.collections.length} collection(s)`);

const nearby = await client.searchNearby({ dataset, collection, region, sort: "distance" });
assert(nearby.complete, `${nearby.tiles.failed} tile(s) failed`);
assert(nearby.places.length > 0, "no places in region");
const distances = nearby.places.map((h) => h.distance);
assert(
  distances.every((d, i) => typeof d === "number" && d <= region.radius && (i === 0 || d >= distances[i - 1])),
  "not distance-ordered within radius",
);
log("searchNearby (no text)", `${nearby.places.length} places from ${nearby.tiles.fetched} tile(s)`);

const named = nearby.places.find((h) => h.origin && typeof h.place.name === "string" && h.place.name);
assert(named, "no named place in region");
const name = named.place.name as string;
const matched = await client.searchNearby({ dataset, collection, region, text: name });
assert(matched.places.some((h) => h.origin === named.origin && h.score !== null), "named place missing from text search");
assert(matched.places[0].score! > 0, "top text hit has no score");
log("searchNearby (text)", `"${name}" -> top hit ${matched.places[0].place.name}, ${matched.places.length} places`);

const point = named.location.point;
assert(point, "named place has no point");
const cell = { bbox: [point.lon, point.lat, point.lon, point.lat] as [number, number, number, number] };
const keyword = await client.searchByKeyword({ dataset, collection, keyword: name, region: cell });
assert(keyword.places.length > 0, "keyword search found nothing in the named place's degree");
assert(keyword.places.every((h) => h.via === "keyword"), "keyword hits are not marked via keyword");
assert.deepEqual(keyword.disclosed, { keyword: true, region: 1 });
log("searchByKeyword", `"${name}" in a 1 degree cell -> ${keyword.places.length} places, top hit ${keyword.places[0].place.name}`);

const solid = await client.searchNearbyThenByKeyword({ dataset, collection, region, keyword: name, keywordRegion: "degree" });
assert(solid.places.some((h) => h.origin === named.origin), "named place missing from the combined search");
assert.deepEqual(solid.disclosed.keyword, false);
log("searchNearbyThenByKeyword (nearby hit)", `${solid.places.length} places, keyword sent: ${solid.disclosed.keyword}`);

const fallback = await client.searchNearbyThenByKeyword({ dataset, collection, region, keyword: "zzzzqqqq", keywordRegion: "none" });
assert.deepEqual(fallback.disclosed.keyword, true);
log("searchNearbyThenByKeyword (fallback)", `${fallback.places.length} places, keyword sent: ${fallback.disclosed.keyword}`);

const typing = client.autocompleteByKeyword({ dataset, collection });
const skipped = await typing.searchByKeyword([...name][0]);
assert.deepEqual(skipped.disclosed, { keyword: false, region: null });
// A prefix of the name's first word of two or more characters, so it qualifies and matches the named place.
const prefix = [...name.split(/[\s\p{P}]+/u).find((w) => [...w].length >= 2)!].slice(0, 3).join("");
const completed = await typing.searchByKeyword(prefix);
assert.deepEqual(completed.disclosed, { keyword: true, region: null });
assert(completed.places.length > 0, "keyword search with no region found nothing");
assert(completed.places.every((h) => h.via === "keyword"), "keyword hits are not marked via keyword");
log("autocompleteByKeyword", `"${prefix}" -> ${completed.places.length} places, one character skipped`);

const origin = named.origin as string;
const fresh = new AtgeoClient({ server });
const record = await fresh.getPlace({ origin });
assert.equal(record.place.name, name);
log("getPlace", `${origin} -> ${record.place.name}`);
