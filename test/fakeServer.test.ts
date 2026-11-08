import { describe, expect, it } from "vitest";
import { fakeServer, overture, place, placeOrigin, point, record, type FakeTileset } from "./helpers/fakeServer.js";

const TILE = "https://tiles.example/a.json";
const ok = place("a", "Alpha", [point(37.772, -122.412)]);
const build = (records: unknown[], tileset: Partial<FakeTileset> = {}) =>
  fakeServer({ tilesets: [{ ...overture([{ url: TILE, records: records as never }]), ...tileset }] });

describe("fake server configuration", () => {
  it("accepts a valid configuration", () => {
    expect(() => build([record(ok, 3)])).not.toThrow();
  });

  it("rejects a record value missing its name", () => {
    const { name: _, ...nameless } = ok;
    expect(() => build([record(nameless)])).toThrow(/name/);
  });

  it("rejects a tile record missing its value", () => {
    expect(() => build([{ importance: 3 }])).toThrow(/"value"/);
  });

  it("rejects a float importance", () => {
    expect(() => build([record(ok, 0.5)])).toThrow(/integer/);
  });

  it("rejects a descriptor missing its slug", () => {
    expect(() => build([], { slug: undefined })).toThrow(/slug/);
  });
});

describe("fake server requests", () => {
  const get = (server: ReturnType<typeof fakeServer>, path: string) => server.fetch(`https://places.atgeo.org${path}`);

  it("answers 400 InvalidRequest to getTiles without a dataset", async () => {
    const response = await get(build([record(ok)]), "/xrpc/org.atgeo.getTiles?bbox=-122.42,37.77,-122.41,37.78");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "InvalidRequest" });
  });

  it("answers 400 InvalidRequest to getPlace with a non-URI uri", async () => {
    const response = await get(build([record(ok)]), "/xrpc/org.atgeo.getPlace?uri=not%20a%20uri");
    expect(response.status).toBe(400);
  });

  it("serves tile bodies with publishedAt, attribution and records", async () => {
    const body = await (await build([record(ok, 3)]).fetch(TILE)).json();
    expect(Object.keys(body).sort()).toEqual(["attribution", "publishedAt", "records"]);
    expect(body.records).toEqual([{ value: ok, importance: 3 }]);
  });

  it("answers getPlace with exactly uri, url, importance, value and attribution", async () => {
    const origin = ok.origin as string;
    const body = await (await get(build([record(ok, 3)]), `/xrpc/org.atgeo.getPlace?uri=${encodeURIComponent(origin)}`)).json();
    expect(Object.keys(body).sort()).toEqual(["attribution", "importance", "uri", "url", "value"]);
    expect(body).toMatchObject({ uri: origin, value: ok, importance: 3, attribution: [{ dataset: "overturemaps.org", collection: "place" }] });
    const bare = await (await get(build([record(ok)]), `/xrpc/org.atgeo.getPlace?uri=${encodeURIComponent(origin)}`)).json();
    expect(Object.keys(bare).sort()).toEqual(["attribution", "uri", "url", "value"]);
  });

  it("emits a tileset's overview in its descriptor", async () => {
    const body = await (await get(build([], { overview: { records: 7 } }), "/xrpc/org.atgeo.describeTileset?slug=overture-place")).json();
    expect(body.overview).toEqual({ records: 7 });
  });

  it("answers describeService with a did and tilesets", async () => {
    const body = await (await get(build([]), "/xrpc/org.atgeo.describeService")).json();
    expect(body).toEqual({
      did: "did:web:places.atgeo.org",
      maxTiles: 50,
      tilesets: [{ slug: "overture-place", collections: [{ dataset: "overturemaps.org", collection: "place" }] }],
    });
  });
});

describe("fake server searchPlaces", () => {
  const records = [
    record(place("a", "Starbucks", [point(37.772, -122.412)]), 5),
    record(place("b", "McDonald's", [point(37.773, -122.413)], { variants: [{ name: "Mickey D's" }] }), 9),
  ];
  const search = async (query: string) => {
    const response = await build(records).fetch(`https://places.atgeo.org/xrpc/org.atgeo.searchPlaces?${query}`);
    return { status: response.status, body: await response.json() };
  };
  const base = "dataset=overturemaps.org&q=star";

  it("answers placeViews, matching each keyword word as a prefix of a word of one name", async () => {
    expect((await search(base)).body.places.map((p: { uri: string }) => p.uri)).toEqual([placeOrigin("a")]);
    for (const q of ["mcdonalds", "mickey", "D%27s%20mick"]) {
      expect((await search(`dataset=overturemaps.org&q=${q}`)).body.places).toHaveLength(1);
    }
    expect((await search("dataset=overturemaps.org&q=mcd%20starb")).body.places).toEqual([]);
  });

  it.each(["a", "%ED%95%98", "%E0%A4%95%E0%A4%BE", "a%20b%27", "%20%20"])("answers 400 KeywordRequired to q=%s", async (q) => {
    const { status, body } = await search(`dataset=overturemaps.org&q=${q}`);
    expect([status, body.error]).toEqual([400, "KeywordRequired"]);
  });

  it.each([
    ["-76.0,39,-75,40", "BboxTooPrecise"],
    ["-76,39,-75,40.5", "BboxTooPrecise"],
    ["1e1,39,20,40", "BboxTooPrecise"],
    ["-76,39,-75", "InvalidBbox"],
    ["a,39,-75,40", "InvalidBbox"],
    ["-76,40,-75,40", "InvalidBbox"],
    ["-75,39,-76,40", "InvalidBbox"],
    ["10,39,10,40", "InvalidBbox"],
    ["180,39,-180,40", "InvalidBbox"],
    ["0,39,-1,40", "InvalidBbox"],
    ["-181,39,-75,40", "InvalidBbox"],
    ["-76,39,-75,91", "InvalidBbox"],
  ])("answers 400 %s with %s", async (bbox, error) => {
    expect((await search(`${base}&bbox=${bbox}`)).body.error).toBe(error);
  });

  it.each(["-76,39,-75,40", "76.,39,77,40", "170,39,-170,40", "-180,39,180,40"])("accepts bbox %s", async (bbox) => {
    expect((await search(`${base}&bbox=${bbox}`)).status).toBe(200);
  });

  it("checks the precision, then the bbox, then the dataset, then the keyword", async () => {
    expect((await search("dataset=nope&q=a&bbox=1.5,2,1,3")).body.error).toBe("BboxTooPrecise");
    expect((await search("dataset=nope&q=a&bbox=2,2,1,3")).body.error).toBe("InvalidBbox");
    expect((await search("dataset=nope&q=a")).body.error).toBe("DatasetNotFound");
    expect((await search("dataset=overturemaps.org&collection=nope&q=a")).body.error).toBe("CollectionNotFound");
    expect((await search("dataset=overturemaps.org&q=a")).body.error).toBe("KeywordRequired");
  });
});
