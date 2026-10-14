/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { AtgeoClient, AtgeoError } from "../src/index.js";
import type { PlaceValue } from "../src/index.js";
import {
  DEFAULT_SERVER,
  bboxLocation,
  fakeServer,
  overture,
  place,
  placeOrigin,
  point,
  record,
  type FakeTileset,
} from "./helpers/fakeServer.js";

const url = (n: string) => `https://tiles.example/${n}.json`;
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };

describe("getPlace", () => {
  const value = place("r1", "Ferry Building", [point(37.7955, -122.3937)], {
    attributes: { kind: "landmark" },
    futureKey: { nested: [1, 2] },
  });
  const origin = placeOrigin("r1");
  const noImportance = place("r2", "No Importance", [point(37.7955, -122.3937)]);

  function setup() {
    const fake = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [record(value, 80), record(noImportance)] }])],
    });
    return { fake, client: new AtgeoClient({ fetch: fake.fetch }) };
  }

  const nsid = (r: { url: string }) => new URL(r.url).pathname.split("/").pop();

  it("sends one getPlace request with the origin as uri on a cold client, and no describeService", async () => {
    const { fake, client } = setup();
    await client.getPlace({ origin });
    expect(fake.requests).toHaveLength(1);
    const u = new URL(fake.requests[0].url);
    expect(u.origin + u.pathname).toBe(`${DEFAULT_SERVER}/xrpc/org.atgeo.getPlace`);
    expect(u.searchParams.get("uri")).toBe(origin);
    expect(fake.requests.map(nsid)).not.toContain("org.atgeo.describeService");
  });

  it("returns the value unmodified with importance beside it", async () => {
    const { client } = setup();
    expect(await client.getPlace({ origin })).toEqual({ origin, place: value, importance: 80 });
  });

  it("returns a null importance when the server gives none", async () => {
    const { client } = setup();
    expect((await client.getPlace({ origin: placeOrigin("r2") })).importance).toBeNull();
  });

  it("returns the same answer from the cache and the network", async () => {
    const { fake, client } = setup();
    const network = await client.getPlace({ origin });
    const fresh = new AtgeoClient({ fetch: fake.fetch });
    await fresh.searchPlaces({ region: { bbox: [-122.40, 37.79, -122.39, 37.80] } });
    const before = fake.requests.length;
    expect(await fresh.getPlace({ origin })).toEqual(network);
    expect(fake.requests.length).toBe(before);
  });

  it("makes no request for the origin of a hit from an earlier search", async () => {
    const { fake, client } = setup();
    const { places } = await client.searchPlaces({ region: { bbox: [-122.40, 37.79, -122.39, 37.80] } });
    const before = fake.requests.length;
    await client.getPlace({ origin: places[0].origin as string });
    expect(fake.requests.length).toBe(before);
  });

  it("resolves a hit identified by a record uri from the cache", async () => {
    const uriOnly = place("u", "By uri", [point(37.775, -122.415)], { origin: undefined });
    const fake = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [record(uriOnly, 4, "https://example.org/r/u")] }])],
    });
    const client = new AtgeoClient({ fetch: fake.fetch });
    const { places } = await client.searchPlaces({ dataset: "overturemaps.org", region });
    expect(places[0].origin).toBe("https://example.org/r/u");
    fake.goOffline();
    expect(await client.getPlace({ origin: places[0].origin as string })).toEqual({
      origin: "https://example.org/r/u",
      place: uriOnly,
      importance: 4,
    });
  });

  it.each([placeOrigin("nope"), "https://example.org/not-an-origin"])("rejects %s with PlaceNotFound", async (unknown) => {
    const { client } = setup();
    const p = client.getPlace({ origin: unknown });
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "PlaceNotFound" });
  });
});

describe("describeService and describeTileset", () => {
  const OSM: FakeTileset = {
    slug: "osm",
    collections: [{ dataset: "openstreetmap.org", collection: "way", recordCount: 3, categories: [{ value: "cafe", count: 2 }] }],
    references: [{ dataset: "openstreetmap.org", collection: "node", licenses: ["https://opendatacommons.org/licenses/odbl/"] }],
    tiles: [],
  };
  const fake = () => fakeServer({ tilesets: [overture([]), OSM] });

  it("describeService returns the did and the configured tilesets", async () => {
    const service = await new AtgeoClient({ fetch: fake().fetch }).describeService();
    expect(service).toEqual({
      did: "did:web:places.atgeo.org",
      tilesets: [
        { slug: "overture-place", collections: [{ dataset: "overturemaps.org", collection: "place" }] },
        { slug: "osm", collections: [{ dataset: "openstreetmap.org", collection: "way" }] },
      ],
    });
    const slugs: string[] = service.tilesets.map((t) => t.slug);
    expect(slugs).toEqual(["overture-place", "osm"]);
  });

  it("describeTileset returns the descriptor", async () => {
    const tileset = await new AtgeoClient({ fetch: fake().fetch }).describeTileset("osm");
    expect(tileset).toEqual({ slug: "osm", collections: OSM.collections, references: OSM.references });
    const slug: string = tileset.slug;
    expect(slug).toBe("osm");
  });

  it("describeTileset asks the server each time", async () => {
    const server = fake();
    const client = new AtgeoClient({ fetch: server.fetch });
    await client.describeTileset("osm");
    await client.describeTileset("osm");
    expect(server.requests).toHaveLength(2);
  });

  it("describeTileset rejects an unknown slug with TilesetNotFound", async () => {
    const p = new AtgeoClient({ fetch: fake().fetch }).describeTileset("nope");
    await expect(p).rejects.toBeInstanceOf(AtgeoError);
    await expect(p).rejects.toMatchObject({ code: "TilesetNotFound" });
  });
});

describe("searchPlaces results", () => {
  const records = [
    record(place("cafe", "Zanzibar Cafe", [point(0.001, 0)], { futureKey: { a: 1 }, variants: [{ name: "ZC" }] }), 2),
    record(place("shop", "Corner Shop", [point(0.002, 0)]), 9),
    record(place("division", "Some Division", [bboxLocation(0.01, -0.01, 0.01, -0.01)]), 1),
  ];
  const circle = { lat: 0, lon: 0, radius: 2000 };

  function setup() {
    const fake = fakeServer({ tilesets: [overture([{ url: url("a"), records }])] });
    return new AtgeoClient({ fetch: fake.fetch });
  }

  it("returns origin, the wire place, importance, meters distance and null score without text", async () => {
    const result = await setup().searchPlaces({ region: circle });
    const cafe = result.places.find((h) => h.origin === placeOrigin("cafe"));
    expect(cafe?.place).toEqual(records[0].value);
    expect(cafe?.place).not.toHaveProperty("importance");
    expect(cafe).not.toHaveProperty("uri");
    expect(cafe?.importance).toBe(2);
    expect(cafe?.distance).toBeCloseTo(111.195, 1);
    expect(result.places.every((h) => h.score === null)).toBe(true);
  });

  it("gives distance 0 to a bbox containing the center", async () => {
    const result = await setup().searchPlaces({ region: circle });
    expect(result.places.find((h) => h.origin === placeOrigin("division"))?.distance).toBe(0);
  });

  it("returns a numeric score with text", async () => {
    const result = await setup().searchPlaces({ region: circle, text: "Zanzibar Cafe" });
    const cafe = result.places.find((h) => h.origin === placeOrigin("cafe"));
    expect(cafe?.score).toBeCloseTo(1, 2);
    expect(result.places.every((h) => typeof h.score === "number")).toBe(true);
  });

  it("treats text that normalizes to empty as no text", async () => {
    const client = setup();
    const none = await client.searchPlaces({ region: circle });
    const blank = await client.searchPlaces({ region: circle, text: "   " });
    expect(blank.places.length).toBeGreaterThan(0);
    expect(blank).toEqual(none);
    expect(blank.places.every((h) => h.score === null)).toBe(true);
  });
});

describe("ordering among places containing the center", () => {
  const ids = async (values: { value: PlaceValue; importance?: number }[], search: Parameters<AtgeoClient["searchPlaces"]>[0]) => {
    const server = fakeServer({
      tilesets: [overture([{ url: url("a"), records: values.map((v) => record(v.value, v.importance)) }])],
    });
    const { places } = await new AtgeoClient({ fetch: server.fetch }).searchPlaces(search);
    return places.map((h) => String(h.origin).slice(placeOrigin("").length));
  };

  it("puts the smaller box first when the center sits on the antimeridian seam", async () => {
    // Center is exactly (45, 180). The small box reaches it as lon -180 / 180.
    const small = place("small", "Small", [bboxLocation(50, 40, -170, -180)]);
    const large = place("large", "Large", [bboxLocation(55, 35, -160, 160)]);
    const order = await ids(
      [
        { value: small, importance: 1 },
        { value: large, importance: 9 },
      ],
      { region: { bbox: [170, 40, -170, 50] }, sort: "distance" },
    );
    expect(order).toEqual(["small", "large"]);
  });

  it.each(["fused", "similarity"] as const)("leaves ties to the origin under %s sort, whatever the sizes", async (sort) => {
    const large = place("a-large", "Same", [bboxLocation(50, 40, 15, 5)]);
    const small = place("b-small", "Same", [bboxLocation(46, 44, 11, 9)]);
    const order = await ids(
      [
        { value: small, importance: 5 },
        { value: large, importance: 5 },
      ],
      { region: { lat: 45, lon: 10, radius: 1000 }, text: "Same", sort },
    );
    expect(order).toEqual(["a-large", "b-small"]);
  });

  it("puts a point at the center before a more important containing box", async () => {
    const order = await ids(
      [
        { value: place("box", "Box", [bboxLocation(46, 44, 11, 9)]), importance: 9 },
        { value: place("pin", "Pin", [point(45, 10)]), importance: 1 },
      ],
      { region: { lat: 45, lon: 10, radius: 1000 }, sort: "distance" },
    );
    expect(order).toEqual(["pin", "box"]);
  });
});

describe("datasets and collections", () => {
  const osm = (kind: string, id: string, lat: number) =>
    place(id, `${kind} ${id}`, [point(lat, -122.415)], { origin: `urn:atgeo:openstreetmap.org:${kind}:${id}` });
  const OSM: FakeTileset = {
    slug: "osm",
    collections: ["node", "way", "relation"].map((collection) => ({ dataset: "openstreetmap.org", collection })),
    tiles: [
      {
        url: url("osm"),
        records: [
          record(osm("node", "1", 37.771)),
          record(osm("way", "2", 37.772)),
          record(osm("relation", "3", 37.773)),
          record(place("u", "By uri", [point(37.774, -122.415)], { origin: undefined }), undefined, "https://example.org/r/u"),
        ],
      },
    ],
  };
  const setup = () => {
    const fake = fakeServer({ tilesets: [overture([]), OSM] });
    return { fake, client: new AtgeoClient({ fetch: fake.fetch }) };
  };
  const params = (fake: { requests: { url: string }[] }) => new URL(fake.requests[0].url).searchParams;
  const tileListRequests = (fake: { requests: { url: string }[] }) =>
    fake.requests.filter((r) => r.url.includes("org.atgeo.getTiles")).map((r) => new URL(r.url).searchParams);

  it("keys the tile list on dataset and collection", async () => {
    const { fake, client } = setup();
    await client.searchPlaces({ dataset: "openstreetmap.org", collection: "way", region });
    await client.searchPlaces({ dataset: "openstreetmap.org", region });
    await client.searchPlaces({ dataset: "overturemaps.org", region });
    expect(tileListRequests(fake).map((p) => `${p.get("dataset")}|${p.get("collection")}`)).toEqual([
      "openstreetmap.org|way",
      "openstreetmap.org|null",
      "overturemaps.org|null",
    ]);
  });

  it("matches the collection, not a collection sharing its prefix", async () => {
    const fake = fakeServer({
      tilesets: [
        {
          slug: "osm",
          collections: ["way", "wayside"].map((collection) => ({ dataset: "openstreetmap.org", collection })),
          tiles: [{ url: url("osm"), records: [record(osm("way", "2", 37.772)), record(osm("wayside", "9", 37.773))] }],
        },
      ],
    });
    const { places } = await new AtgeoClient({ fetch: fake.fetch }).searchPlaces({
      dataset: "openstreetmap.org",
      collection: "way",
      region,
    });
    expect(places.map((h) => h.origin)).toEqual(["urn:atgeo:openstreetmap.org:way:2"]);
  });

  it("searches a whole dataset when only the dataset is named", async () => {
    const { fake, client } = setup();
    const { places } = await client.searchPlaces({ dataset: "openstreetmap.org", region });
    expect(places.map((h) => h.origin).sort()).toEqual([
      "https://example.org/r/u",
      "urn:atgeo:openstreetmap.org:node:1",
      "urn:atgeo:openstreetmap.org:relation:3",
      "urn:atgeo:openstreetmap.org:way:2",
    ]);
    expect(params(fake).get("dataset")).toBe("openstreetmap.org");
    expect(params(fake).has("collection")).toBe(false);
  });

  it("filters to one collection, dropping records with no origin", async () => {
    const { fake, client } = setup();
    const { places } = await client.searchPlaces({ dataset: "openstreetmap.org", collection: "way", region });
    expect(places.map((h) => h.origin)).toEqual(["urn:atgeo:openstreetmap.org:way:2"]);
    expect(params(fake).get("collection")).toBe("way");
  });

  it("defaults to overturemaps.org / place when nothing is named", async () => {
    const { fake, client } = setup();
    await client.searchPlaces({ region });
    expect(params(fake).get("dataset")).toBe("overturemaps.org");
    expect(params(fake).get("collection")).toBe("place");
  });

  it("takes overturemaps.org for a collection named alone", async () => {
    const { fake, client } = setup();
    await client.searchPlaces({ collection: "division", region }).catch(() => {});
    expect(params(fake).get("dataset")).toBe("overturemaps.org");
    expect(params(fake).get("collection")).toBe("division");
  });
});

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("retired wire names", () => {
  it.each(Object.entries(sources))("%s mentions no retired collection, record or coverage names", (_file, text) => {
    expect(text).not.toMatch(/org\.atgeo\.collection|getRecord|getCoverage|rkey/);
  });
});

describe("universal runtime (R9)", () => {
  const NODE_MODULE =
    /(?:from|import|require)\s*\(?\s*["'](?:node:[^"']*|(?:assert|buffer|child_process|cluster|crypto|dns|events|fs|http|http2|https|net|os|path|perf_hooks|process|querystring|readline|stream|string_decoder|timers|tls|url|util|vm|worker_threads|zlib)(?:\/[^"']*)?)["']/;

  it("reads the source files", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(sources))("%s imports no Node builtins", (_file, text) => {
    expect(text).not.toMatch(NODE_MODULE);
  });

  it.each(Object.entries(sources))("%s references no DOM globals", (_file, text) => {
    expect(text).not.toMatch(/\b(?:window|document)\b/);
  });
});
