import { describe, expect, it } from "vitest";
import { AtgeoClient, AtgeoError, DecodingError } from "../src/index.js";
import { OVERTURE, place, placeOrigin, point } from "./helpers/fakeServer.js";

// What the client does with malformed but well-formed-JSON bodies (contract section 1): a missing or
// wrong-typed field is absent, an unusable record or element is skipped, and only a body with nothing
// usable fails the call. The fake server validates against the lexicons, so these use a raw server.

const SERVER = "https://places.atgeo.org";
const tileUrl = (n: string) => `https://tiles.example/${n}.json`;
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const here = point(37.772, -122.412);

type Body = unknown;
type Route = Body | (() => Response);

// Answers each XRPC method, and each tile URL, with the body given, as JSON, or with a Response.
function rawServer(routes: { getTiles?: Route; getPlace?: Route; describeService?: Route; describeTileset?: Route; tiles?: Record<string, Route> }) {
  const requests: string[] = [];
  const answer = (route: Route): Response => (typeof route === "function" ? (route as () => Response)() : new Response(JSON.stringify(route)));
  const fetch = (async (input: RequestInfo | URL) => {
    const href = new Request(input).url;
    requests.push(href);
    const nsid = new URL(href).pathname.split("/").pop() as keyof typeof routes;
    if (href.startsWith(`${SERVER}/xrpc/org.atgeo.`)) {
      const route = routes[nsid.replace("org.atgeo.", "") as keyof typeof routes] as Route | undefined;
      return route === undefined ? new Response("{}", { status: 501 }) : answer(route);
    }
    const tile = routes.tiles?.[href];
    return tile === undefined ? new Response("Not found", { status: 404 }) : answer(tile);
  }) as typeof globalThis.fetch;
  return { fetch, requests, nonXrpc: () => requests.filter((u) => !u.includes("/xrpc/")) };
}

const withTiles = (records: Body[], extra: { tiles?: Record<string, Route> } = {}) =>
  rawServer({ getTiles: { tiles: [tileUrl("a")] }, tiles: { [tileUrl("a")]: { records }, ...extra.tiles } });

const ids = (places: { origin: string | null }[]) => places.map((h) => h.origin);

describe("getTiles body", () => {
  it.each([
    ["an empty object", {}],
    ["an array", []],
    ["null", null],
    ["a string tiles", { tiles: "x" }],
  ])("fails the search with a DecodingError on %s, requesting no tile", async (_name, body) => {
    const server = rawServer({ getTiles: body });
    await expect(new AtgeoClient({ fetch: server.fetch }).searchPlaces({ ...OVERTURE, region })).rejects.toBeInstanceOf(DecodingError);
    expect(server.nonXrpc()).toEqual([]);
  });

  it("caches nothing from a body with no tiles array", async () => {
    let body: Body = {};
    const server = rawServer({ getTiles: () => new Response(JSON.stringify(body)), tiles: { [tileUrl("a")]: { records: [{ value: place("a", "A", [here]) }] } } });
    const client = new AtgeoClient({ fetch: server.fetch });
    await expect(client.searchPlaces({ ...OVERTURE, region })).rejects.toBeInstanceOf(DecodingError);
    body = { tiles: [tileUrl("a")] };
    const result = await client.searchPlaces({ ...OVERTURE, region });
    expect(ids(result.places)).toEqual([placeOrigin("a")]);
    expect(server.requests.filter((u) => u.includes("getTiles"))).toHaveLength(2);
  });

  it("skips entries that are not strings instead of reporting them as tiles", async () => {
    const server = rawServer({
      getTiles: { tiles: [5, null, [tileUrl("a")], tileUrl("a")] },
      tiles: { [tileUrl("a")]: { records: [{ value: place("a", "A", [here]) }] } },
    });
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ ...OVERTURE, region });
    expect(result).toMatchObject({ complete: true, tiles: { fetched: 1, failed: 0 }, tileFailures: [] });
    expect(server.nonXrpc()).toEqual([tileUrl("a")]);
  });
});

describe("tile records", () => {
  const good = { value: place("good", "Good", [here]), importance: 4 };

  it("skips a record that is not an object, or has no object value, and keeps the tile", async () => {
    const server = withTiles([null, 5, "s", [], true, {}, { value: null }, { value: 5 }, { value: [] }, good]);
    const client = new AtgeoClient({ fetch: server.fetch });
    const result = await client.searchPlaces({ ...OVERTURE, region });
    expect(result).toMatchObject({ complete: true, tiles: { fetched: 1, failed: 0 }, tileFailures: [] });
    expect(ids(result.places)).toEqual([placeOrigin("good")]);
  });

  it("does not let a skipped record consume a dedupe key", async () => {
    const server = rawServer({
      getTiles: { tiles: [tileUrl("a"), tileUrl("b")] },
      tiles: {
        [tileUrl("a")]: { records: [{ value: 5, uri: "u-1" }, { value: null, uri: "u-2" }] },
        [tileUrl("b")]: { records: [{ value: { name: "B", locations: [here] }, uri: "u-1" }] },
      },
    });
    // A dataset-only search, since a collection filter drops records with no origin.
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region, dataset: "overturemaps.org" });
    expect(ids(result.places)).toEqual(["u-1"]);
  });

  it("leaves a cache that later searches and getPlace can read without throwing", async () => {
    const server = withTiles([null, { value: 5 }, good]);
    const client = new AtgeoClient({ fetch: server.fetch });
    await client.searchPlaces({ ...OVERTURE, region });
    const again = await client.searchPlaces({ ...OVERTURE, region });
    expect(ids(again.places)).toEqual([placeOrigin("good")]);
    const before = server.requests.length;
    expect(await client.getPlace({ origin: placeOrigin("good") })).toMatchObject({ importance: 4 });
    await expect(client.getPlace({ origin: "urn:atgeo:overturemaps.org:place:missing" })).rejects.toBeInstanceOf(AtgeoError);
    expect(server.requests.length).toBe(before + 1);
  });

  it("reads a uri that is not a string as absent: no origin, not a dedupe key", async () => {
    const server = withTiles([
      { value: { name: "One", locations: [here] }, uri: 5 },
      { value: { name: "Two", locations: [here] }, uri: 5 },
    ]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ region, dataset: "overturemaps.org" });
    expect(result.places.map((h) => [h.origin, h.place.name])).toEqual([
      [null, "One"],
      [null, "Two"],
    ]);
  });

  it.each([["a string", "9"], ["true", true], ["an array", [9]], ["too large", 1e30]])("reads an importance that is %s as absent", async (_name, importance) => {
    const server = withTiles([{ value: place("p", "P", [here]), importance }]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ ...OVERTURE, region });
    expect(result.places.map((h) => h.importance)).toEqual([null]);
  });
});

describe("tile attribution", () => {
  const good = { value: place("good", "Good", [here]), importance: 4 };
  const search = (tile: Body) =>
    new AtgeoClient({ fetch: rawServer({ getTiles: { tiles: [tileUrl("a")] }, tiles: { [tileUrl("a")]: tile } }).fetch }).searchPlaces({ ...OVERTURE, region });

  it("gives a search whose tiles lack attribution an empty attribution and null hit collections", async () => {
    const result = await search({ records: [good] });
    expect(result.attribution).toStrictEqual([]);
    expect(result.places).toHaveLength(1);
    for (const hit of result.places) expect(hit).toHaveProperty("collection", null);
  });

  it.each([["a string", "x"], ["an object", {}], ["null", null], ["a number", 5]])("does not fail the tile for an attribution that is %s", async (_name, attribution) => {
    const result = await search({ records: [good], attribution });
    expect(result).toMatchObject({ complete: true, tiles: { fetched: 1, failed: 0 }, tileFailures: [] });
    expect(result.attribution).toStrictEqual([]);
    expect(ids(result.places)).toEqual([placeOrigin("good")]);
  });

  it("drops the entries that lack a string dataset and collection, and keeps the tile", async () => {
    const result = await search({ records: [good], attribution: [null, 5, { dataset: "d" }, { dataset: "overturemaps.org", collection: "place" }] });
    expect(result.complete).toBe(true);
    expect(result.attribution).toStrictEqual([{ dataset: "overturemaps.org", collection: "place" }]);
    expect(result.places[0].collection).toStrictEqual({ dataset: "overturemaps.org", collection: "place" });
  });
});

describe("place locations and variants", () => {
  it("skips a null element of locations", async () => {
    const server = withTiles([{ value: place("p", "P", [null, 5, "x", [], here]) }]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ ...OVERTURE, region });
    expect(ids(result.places)).toEqual([placeOrigin("p")]);
  });

  it("skips a null element of locations that comes after the point, and in a circle search", async () => {
    const server = withTiles([{ value: place("p", "P", [here, null]) }]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ ...OVERTURE, region: { lat: 37.772, lon: -122.412, radius: 100 } });
    expect(ids(result.places)).toEqual([placeOrigin("p")]);
  });

  it("skips a null element of variants when the search has text, and still scores the others", async () => {
    const server = withTiles([{ value: place("p", "Unrelated", [here], { variants: [null, 5, [], { name: 7 }, { name: "Zanzibar" }] }) }]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ ...OVERTURE, region, text: "Zanzibar" });
    expect(ids(result.places)).toEqual([placeOrigin("p")]);
    expect(result.places[0].score).toBeCloseTo(1, 2);
  });

  it("reads a coordinate that is a one-element array as no location", async () => {
    const wrong = { $type: "community.lexicon.location.geo", latitude: [37.772], longitude: [-122.412] };
    const right = { $type: "community.lexicon.location.geo", latitude: 37.772, longitude: "-122.412" };
    const server = withTiles([{ value: place("array", "A", [wrong]) }, { value: place("numbers", "N", [wrong, right]) }]);
    const result = await new AtgeoClient({ fetch: server.fetch }).searchPlaces({ ...OVERTURE, region });
    expect(ids(result.places)).toEqual([placeOrigin("numbers")]);
  });
});

describe("error bodies", () => {
  const getPlace = (response: () => Response) =>
    new AtgeoClient({ fetch: rawServer({ getPlace: response }).fetch }).getPlace({ origin: "urn:atgeo:overturemaps.org:place:x" });
  const body = (text: string, status = 500) => () => new Response(text, { status });

  it.each([
    ["error and message that are not strings", `{"error":5,"message":["x"]}`, "HttpError", "HTTP 500"],
    ["null error and message", `{"error":null,"message":null}`, "HttpError", "HTTP 500"],
    ["a string error beside a non-string message", `{"error":"Custom","message":5}`, "Custom", "HTTP 500"],
    ["a non-string error beside a string message", `{"error":{},"message":"words"}`, "HttpError", "words"],
    ["a string error and message", `{"error":"Custom","message":"words"}`, "Custom", "words"],
    ["a body of null", "null", "HttpError", "HTTP 500"],
    ["a body that is an array", `["error"]`, "HttpError", "HTTP 500"],
    ["a body that is a string", `"error"`, "HttpError", "HTTP 500"],
    ["a body that is not JSON", "<html>", "HttpError", "HTTP 500"],
  ])("builds an AtgeoError from %s", async (_name, text, code, message) => {
    const error = await getPlace(body(text)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtgeoError);
    expect(error).toMatchObject({ code, message, status: 500 });
  });
});

describe("getPlace body", () => {
  const origin = "urn:atgeo:overturemaps.org:place:x";
  const get = (route: Route) => new AtgeoClient({ fetch: rawServer({ getPlace: route }).fetch }).getPlace({ origin });

  it.each([
    ["null", null],
    ["an array", []],
    ["an empty object", {}],
    ["a null value", { value: null }],
    ["an array value", { value: [] }],
    ["a string value", { value: "x" }],
    ["the earlier shape, record and no value", { uri: "x", record: { name: "X" } }],
  ])("rejects with a DecodingError on %s", async (_name, body) => {
    await expect(get(body)).rejects.toBeInstanceOf(DecodingError);
  });

  it("returns the value as served, with an importance that is not a number as null", async () => {
    expect(await get({ uri: 5, value: { name: "X", extra: { n: [1] } }, importance: "high" })).toEqual({
      origin,
      place: { name: "X", extra: { n: [1] } },
      name: "X",
      location: { point: null, bbox: null },
      importance: null,
      attribution: [],
    });
  });

  it("succeeds on the new-shape body and returns its attribution as served", async () => {
    const attribution = [{ dataset: "d", collection: "c", licenses: ["l"] }];
    const body = { uri: origin, url: "https://x.example/p", importance: 3, value: { name: "X" }, attribution };
    expect(await get(body)).toStrictEqual({
      origin,
      place: { name: "X" },
      name: "X",
      location: { point: null, bbox: null },
      importance: 3,
      attribution,
    });
  });
});

describe("describeService body", () => {
  it.each([["null", null], ["false", false], ["0", 0], ["an empty string", ""], ["an array", []], ["a string", "x"]])(
    "rejects with a DecodingError on %s, and caches nothing",
    async (_name, bad) => {
      let body: Body = bad;
      const server = rawServer({ describeService: () => new Response(JSON.stringify(body)) });
      const client = new AtgeoClient({ fetch: server.fetch });
      await expect(client.describeService()).rejects.toBeInstanceOf(DecodingError);
      await expect(client.describeService()).rejects.toBeInstanceOf(DecodingError);
      body = { did: "did:web:x", tilesets: [] };
      expect(await client.describeService()).toEqual({ did: "did:web:x", tilesets: [] });
      expect(server.requests).toHaveLength(3);
    },
  );

  it("caches an object body for an hour, however sparse", async () => {
    const server = rawServer({ describeService: {} });
    const client = new AtgeoClient({ fetch: server.fetch });
    expect(await client.describeService()).toEqual({ tilesets: [] });
    expect(await client.describeService()).toEqual({ tilesets: [] });
    expect(server.requests).toHaveLength(1);
  });

  it("reads wrong-typed fields as absent and drops unreadable elements", async () => {
    const server = rawServer({ describeService: { did: 5, tilesets: [null, { slug: 1, collections: [null, { dataset: "d", collection: 2 }] }] } });
    const service = await new AtgeoClient({ fetch: server.fetch }).describeService();
    expect(service).toStrictEqual({ tilesets: [{ collections: [{ dataset: "d" }] }] });
  });
});

describe("describeTileset body", () => {
  it.each([["null", null], ["an array", []], ["a string", "x"]])("rejects with a DecodingError on %s", async (_name, body) => {
    const server = rawServer({ describeTileset: body });
    await expect(new AtgeoClient({ fetch: server.fetch }).describeTileset("s")).rejects.toBeInstanceOf(DecodingError);
  });

  it("reads a sparse and wrong-typed body leniently", async () => {
    const server = rawServer({ describeTileset: { slug: 5, collections: [{ dataset: "d", collection: "c", recordCount: "3" }, null] } });
    expect(await new AtgeoClient({ fetch: server.fetch }).describeTileset("s")).toStrictEqual({
      collections: [{ dataset: "d", collection: "c" }],
    });
  });
});

describe("a 2xx body that is not JSON", () => {
  const broken = () => new Response("{");
  const origin = "urn:atgeo:overturemaps.org:place:x";

  // Invalid JSON is the platform's SyntaxError, not a DecodingError (contract section 1).
  it.each([
    ["getTiles", (c: AtgeoClient) => c.searchPlaces({ ...OVERTURE, region }), { getTiles: broken }],
    ["getPlace", (c: AtgeoClient) => c.getPlace({ origin }), { getPlace: broken }],
    ["describeService", (c: AtgeoClient) => c.describeService(), { describeService: broken }],
    ["describeTileset", (c: AtgeoClient) => c.describeTileset("s"), { describeTileset: broken }],
  ])("rejects %s with a SyntaxError", async (_name, call, routes) => {
    const error = await call(new AtgeoClient({ fetch: rawServer(routes).fetch })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error).not.toBeInstanceOf(DecodingError);
  });

  it("reports a tile payload as a decode failure whose error is a SyntaxError", async () => {
    const result = await new AtgeoClient({ fetch: rawServer({ getTiles: { tiles: [tileUrl("a")] }, tiles: { [tileUrl("a")]: broken } }).fetch }).searchPlaces({ ...OVERTURE, region });
    expect(result.tileFailures).toEqual([{ url: tileUrl("a"), kind: "decode", error: expect.any(SyntaxError) }]);
  });
});
