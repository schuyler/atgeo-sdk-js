import assert from "node:assert/strict";
import { AtgeoClient } from "../src/index.js";

const server = process.env.ATGEO_SERVER ?? "http://localhost:8000";
const collection = process.env.ATGEO_COLLECTION ?? "org.atgeo.places.osm";
// "lat,lon,radius" in meters; the default is Manchester, NH, inside the local OSM New Hampshire tileset.
const [lat, lon, radius] = (process.env.ATGEO_REGION ?? "43.0,-71.45,3000").split(",").map(Number);
const region = { lat, lon, radius };

const client = new AtgeoClient({ server });
const log = (step: string, detail: string) => console.log(`ok  ${step}: ${detail}`);

const service = await client.describeService();
assert(service.collections.some((c) => c.collection === collection), `${collection} not served`);
log("describeService", `${service.did}, ${service.collections.length} collection(s)`);

const info = await client.getCollectionInfo(collection);
assert(info && info.collection === collection, "getCollectionInfo returned no matching record");
log("getCollectionInfo", `${info.recordCount} records, source ${info.source}`);

const nearby = await client.searchPlaces({ collection, region });
assert(nearby.complete, `${nearby.tiles.failed} tile(s) failed`);
assert(nearby.places.length > 0, "no places in region");
const distances = nearby.places.map((h) => h.distance as number);
assert(distances.every((d, i) => d <= region.radius && (i === 0 || d >= distances[i - 1])), "not distance-ordered within radius");
log("searchPlaces (no text)", `${nearby.places.length} places from ${nearby.tiles.fetched} tile(s)`);

const named = nearby.places.find((h) => typeof h.place.name === "string" && h.place.name);
assert(named, "no named place in region");
const name = named.place.name as string;
const matched = await client.searchPlaces({ collection, region, text: name });
assert(matched.places.some((h) => h.uri === named.uri && h.score !== null), "named place missing from text search");
assert(matched.places[0].score! > 0, "top text hit has no score");
log("searchPlaces (text)", `"${name}" -> top hit ${matched.places[0].place.name}, ${matched.places.length} places`);

const rkey = named.place.rkey as string;
const fresh = new AtgeoClient({ server });
const record = await fresh.getPlace({ collection, rkey });
assert.equal(record.place.name, name);
log("getPlace", `${rkey} -> ${record.uri}`);
