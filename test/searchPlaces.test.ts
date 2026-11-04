import { describe, expect, it } from "vitest";
import { AtgeoClient, AtgeoError, DecodingError } from "../src/index.js";
import { degreeBbox } from "../src/region.js";
import { DEFAULT_SERVER, fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

const DATASET = "overturemaps.org";
const ATTRIBUTION = [{ dataset: DATASET, collection: "place" }];
const nsid = (r: { url: string }) => new URL(r.url).pathname.split("/").pop();

const view = (id: string, name: string, importance?: number) => ({
  uri: placeOrigin(id),
  url: `${DEFAULT_SERVER}/${DATASET}/place/${id}`,
  ...(importance === undefined ? {} : { importance }),
  value: place(id, name, [point(37.7955, -122.3937)]),
  attribution: ATTRIBUTION,
});

function setup(places: unknown[] = []) {
  const fake = fakeServer({
    searchPlaces: { places },
    tilesets: [overture([{ url: "https://tiles.example/a.json", records: [record(view("r1", "Ferry Building", 80).value, 80)] }])],
  });
  return { fake, client: new AtgeoClient({ fetch: fake.fetch }) };
}

const sent = (fake: { requests: { url: string }[] }) => new URL(fake.requests[0].url);

describe("searchPlaces arguments", () => {
  const badRegion = { bbox: [0, 10, 1, 5] } as never;

  it.each([
    ["dataset missing", { keyword: "x" }, /dataset/],
    ["dataset not a string", { dataset: 5, keyword: "x" }, /dataset/],
    ["keyword missing", { dataset: DATASET }, /keyword/],
    ["keyword not a string", { dataset: DATASET, keyword: 5 }, /keyword/],
    ["invalid region", { dataset: DATASET, keyword: "x", region: badRegion }, /^invalid bbox$/],
  ])("throws TypeError synchronously, before any request: %s", (_name, options, message) => {
    const { fake, client } = setup();
    expect(() => client.searchPlaces(options as never)).toThrow(TypeError);
    expect(() => client.searchPlaces(options as never)).toThrow(message);
    expect(fake.requests).toHaveLength(0);
  });

  it("checks dataset, then keyword, then region", () => {
    const { client } = setup();
    expect(() => client.searchPlaces({ dataset: 1, keyword: 2, region: badRegion } as never)).toThrow(/dataset/);
    expect(() => client.searchPlaces({ dataset: DATASET, keyword: 2, region: badRegion } as never)).toThrow(/keyword/);
    expect(() => client.searchPlaces({ dataset: DATASET, keyword: "x", region: badRegion })).toThrow(/invalid bbox/);
  });

  it("throws on a stale call that gives text and no keyword, and sends nothing", () => {
    const { fake, client } = setup();
    const region = { bbox: [-122.42, 37.77, -122.41, 37.78] };
    expect(() => client.searchPlaces({ dataset: DATASET, region, text: "Zanzibar" } as never)).toThrow(TypeError);
    expect(() => client.searchPlaces({ dataset: DATASET, region, text: "Zanzibar" } as never)).toThrow(/keyword/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("searchPlaces request", () => {
  it("sends one GET to org.atgeo.searchPlaces with dataset and q, and no collection or bbox", async () => {
    const { fake, client } = setup();
    await client.searchPlaces({ dataset: DATASET, keyword: "ferry" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe("GET");
    const u = sent(fake);
    expect(u.origin + u.pathname).toBe(`${DEFAULT_SERVER}/xrpc/org.atgeo.searchPlaces`);
    expect([...u.searchParams.keys()]).toEqual(["dataset", "q"]);
    expect(u.searchParams.get("dataset")).toBe(DATASET);
    expect(u.searchParams.get("q")).toBe("ferry");
  });

  it("sends the collection when given, in the order dataset, collection, q", async () => {
    const { fake, client } = setup();
    await client.searchPlaces({ dataset: DATASET, collection: "place", keyword: "ferry" });
    expect([...sent(fake).searchParams.keys()]).toEqual(["dataset", "collection", "q"]);
    expect(sent(fake).searchParams.get("collection")).toBe("place");
  });

  it("sends the keyword verbatim", async () => {
    const { fake, client } = setup();
    await client.searchPlaces({ dataset: DATASET, keyword: "  St. Louis  " });
    expect(sent(fake).searchParams.get("q")).toBe("  St. Louis  ");
  });

  it("sends the whole-degree bbox of a bbox region", async () => {
    const { fake, client } = setup();
    const region = { bbox: [-122.42, 37.77, -122.41, 37.78] } as const;
    await client.searchPlaces({ dataset: DATASET, keyword: "ferry", region: { bbox: [...region.bbox] } });
    expect(fake.requests).toHaveLength(1);
    expect([...sent(fake).searchParams.keys()]).toEqual(["dataset", "q", "bbox"]);
    expect(sent(fake).searchParams.get("bbox")).toBe("-123,37,-122,38");
  });

  it("sends the whole-degree bbox of a circle region, and the bbox is last after the collection", async () => {
    const { fake, client } = setup();
    const region = { lat: 10, lon: 20, radius: 111194.927 };
    await client.searchPlaces({ dataset: DATASET, collection: "place", keyword: "ferry", region });
    expect([...sent(fake).searchParams.keys()]).toEqual(["dataset", "collection", "q", "bbox"]);
    expect(sent(fake).searchParams.get("bbox")).toBe(degreeBbox(region));
    expect(sent(fake).searchParams.get("bbox")).toBe("18,9,22,11");
  });

  it("sends a crossing region as one request with a crossing bbox", async () => {
    const { fake, client } = setup();
    await client.searchPlaces({ dataset: DATASET, keyword: "ferry", region: { bbox: [170.5, 10, -170.5, 20] } });
    expect(fake.requests).toHaveLength(1);
    expect(sent(fake).searchParams.get("bbox")).toBe("170,10,-170,20");
  });

  it("makes a request for each of two identical calls", async () => {
    const { fake, client } = setup([view("r1", "Ferry Building", 80)]);
    await client.searchPlaces({ dataset: DATASET, keyword: "ferry" });
    await client.searchPlaces({ dataset: DATASET, keyword: "ferry" });
    expect(fake.requests.map(nsid)).toEqual(["org.atgeo.searchPlaces", "org.atgeo.searchPlaces"]);
  });

  it("does not fill the cache getPlace reads: getPlace of a hit makes a request", async () => {
    const { fake, client } = setup([view("r1", "Ferry Building", 80)]);
    const { places } = await client.searchPlaces({ dataset: DATASET, keyword: "ferry" });
    const before = fake.requests.length;
    await client.getPlace({ origin: places[0].origin as string });
    expect(fake.requests.length).toBe(before + 1);
    expect(nsid(fake.requests[before])).toBe("org.atgeo.getPlace");
  });
});

describe("searchPlaces result", () => {
  it("gives each hit the shape getPlace gives", async () => {
    const { fake, client } = setup([view("r1", "Ferry Building", 80)]);
    const { places } = await client.searchPlaces({ dataset: DATASET, keyword: "ferry" });
    expect(places).toEqual([
      {
        origin: placeOrigin("r1"),
        place: view("r1", "Ferry Building").value,
        name: "Ferry Building",
        location: { point: { lat: 37.7955, lon: -122.3937 }, bbox: null },
        importance: 80,
        attribution: ATTRIBUTION,
      },
    ]);
    expect(Object.isFrozen(places[0].place)).toBe(true);
    expect(places[0]).toEqual(await new AtgeoClient({ fetch: fake.fetch }).getPlace({ origin: placeOrigin("r1") }));
  });

  it("gives a null importance when the server gives none", async () => {
    const { client } = setup([view("r2", "No Importance")]);
    const { places } = await client.searchPlaces({ dataset: DATASET, keyword: "no" });
    expect(places[0].importance).toBeNull();
  });

  it("takes the origin from the hit's uri, not from the place value", async () => {
    const hit = { ...view("r1", "Ferry Building"), uri: "https://example.org/r/u" };
    const { client } = setup([hit]);
    const { places } = await client.searchPlaces({ dataset: DATASET, keyword: "ferry" });
    expect(places[0].origin).toBe("https://example.org/r/u");
  });

  it("keeps the server's order", async () => {
    const { client } = setup([view("c", "C", 1), view("a", "A", 9), view("b", "B")]);
    const { places } = await client.searchPlaces({ dataset: DATASET, keyword: "x" });
    expect(places.map((p) => p.origin)).toEqual([placeOrigin("c"), placeOrigin("a"), placeOrigin("b")]);
  });

  it("returns no places for an empty answer", async () => {
    const { client } = setup([]);
    expect(await client.searchPlaces({ dataset: DATASET, keyword: "x" })).toEqual({ places: [] });
  });
});

describe("searchPlaces errors", () => {
  it("rejects with the server's error name and the HTTP status", async () => {
    const fake = fakeServer({ searchPlaces: { error: "KeywordRequired", message: "need two letters" } });
    const error = await new AtgeoClient({ fetch: fake.fetch }).searchPlaces({ dataset: DATASET, keyword: "a" }).catch((e) => e);
    expect(error).toBeInstanceOf(AtgeoError);
    expect(error.code).toBe("KeywordRequired");
    expect(error.status).toBe(400);
  });

  it.each([{}, { places: "x" }, { places: { a: 1 } }, null, []])("rejects with DecodingError for the body %j", async (body) => {
    const fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
    await expect(new AtgeoClient({ fetch }).searchPlaces({ dataset: DATASET, keyword: "x" })).rejects.toBeInstanceOf(DecodingError);
  });
});
