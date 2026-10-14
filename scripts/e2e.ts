import assert from "node:assert/strict";
import { AtgeoClient } from "../src/index.js";

const server = process.env.ATGEO_SERVER ?? "http://localhost:8000";
const dataset = process.env.ATGEO_DATASET ?? "openstreetmap.org";
const collection = process.env.ATGEO_COLLECTION;
// "lat,lon,radius" in meters; the default is Manchester, NH, inside the local OSM New Hampshire tileset.
const [lat, lon, radius] = (process.env.ATGEO_REGION ?? "43.0,-71.45,3000").split(",").map(Number);
const region = { lat, lon, radius };

const client = new AtgeoClient({ server });
const log = (step: string, detail: string) => console.log(`ok  ${step}: ${detail}`);

const service = await client.describeService();
const served = service.tilesets.find((t) => t.collections.some((c) => c.dataset === dataset));
assert(served, `${dataset} not served`);
log("describeService", `${service.did}, ${service.tilesets.length} tileset(s)`);

const tileset = await client.describeTileset(served.slug);
assert(tileset.collections.some((c) => c.dataset === dataset), "describeTileset does not list the dataset");
log("describeTileset", `${tileset.slug}, ${tileset.collections.length} collection(s)`);

const nearby = await client.searchPlaces({ dataset, collection, region });
assert(nearby.complete, `${nearby.tiles.failed} tile(s) failed`);
assert(nearby.places.length > 0, "no places in region");
const distances = nearby.places.map((h) => h.distance as number);
assert(distances.every((d, i) => d <= region.radius && (i === 0 || d >= distances[i - 1])), "not distance-ordered within radius");
log("searchPlaces (no text)", `${nearby.places.length} places from ${nearby.tiles.fetched} tile(s)`);

const named = nearby.places.find((h) => h.origin && typeof h.place.name === "string" && h.place.name);
assert(named, "no named place in region");
const name = named.place.name as string;
const matched = await client.searchPlaces({ dataset, collection, region, text: name });
assert(matched.places.some((h) => h.origin === named.origin && h.score !== null), "named place missing from text search");
assert(matched.places[0].score! > 0, "top text hit has no score");
log("searchPlaces (text)", `"${name}" -> top hit ${matched.places[0].place.name}, ${matched.places.length} places`);

const origin = named.origin as string;
const fresh = new AtgeoClient({ server });
const record = await fresh.getPlace({ origin });
assert.equal(record.place.name, name);
log("getPlace", `${origin} -> ${record.place.name}`);
