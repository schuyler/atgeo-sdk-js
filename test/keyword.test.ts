import { describe, expect, it } from "vitest";
import { AtgeoClient, AtgeoError } from "../src/index.js";
import { OVERTURE, fakeServer, overture, place, placeOrigin, point, record, type FakeTileset } from "./helpers/fakeServer.js";

const DIVISION = "urn:atgeo:overturemaps.org:division:d1";
const tilesets: FakeTileset[] = [
  overture([
    {
      url: "https://tiles.example/p.json",
      records: [
        record(place("starbucks-3", "Starbucks", [point(37.7, -122.4)]), 5),
        record(place("starbucks-1", "Starbucks", [point(37.775, -122.418)], { futureKey: { a: 1 } }), 5),
        record(place("starbucks-2", "Starbucks Reserve", [point(37.8, -122.3)]), 9),
        record(place("mcd", "McDonald's", [point(37.78, -122.41)]), 7),
      ],
    },
  ]),
  {
    slug: "overture-division",
    collections: [{ dataset: "overturemaps.org", collection: "division" }],
    tiles: [
      {
        url: "https://tiles.example/d.json",
        records: [record(place("d1", "Starbucks District", [point(37.9, -122.5)], { origin: DIVISION }), 1)],
      },
    ],
  },
];

function setup() {
  const server = fakeServer({ tilesets });
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

const paramsOf = (request: { url: string }) => Object.fromEntries(new URL(request.url).searchParams);

describe("searchByKeyword", () => {
  it("returns the server's matches in the server's order, as keyword hits", async () => {
    const { client } = setup();
    const result = await client.searchByKeyword({ dataset: "overturemaps.org", collection: "place", keyword: "starb" });
    expect(result.places.map((h) => h.origin)).toEqual([
      placeOrigin("starbucks-2"),
      placeOrigin("starbucks-1"),
      placeOrigin("starbucks-3"),
    ]);
    const hit = result.places[1];
    expect(hit).toMatchObject({
      via: "keyword",
      name: "Starbucks",
      importance: 5,
      collection: { dataset: "overturemaps.org", collection: "place" },
      location: { point: { lat: 37.775, lon: -122.418 }, bbox: null },
    });
    expect(hit.place).toEqual(tilesets[0].tiles[0].records[1].value);
    expect(hit).not.toHaveProperty("distance");
    expect(hit).not.toHaveProperty("score");
  });

  it("credits each hit's own collection and the union of the places' attribution", async () => {
    const { client } = setup();
    const result = await client.searchByKeyword({ dataset: "overturemaps.org", keyword: "starb" });
    expect(result.places.map((h) => h.collection?.collection)).toEqual(["place", "place", "place", "division"]);
    expect(result.attribution).toStrictEqual([
      { dataset: "overturemaps.org", collection: "division" },
      { dataset: "overturemaps.org", collection: "place" },
    ]);
  });

  it("sends exactly dataset and q when given no collection or region", async () => {
    const { server, client } = setup();
    await client.searchByKeyword({ dataset: "overturemaps.org", keyword: "Starb" });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toContain("/xrpc/org.atgeo.searchPlaces?");
    expect(paramsOf(server.requests[0])).toEqual({ dataset: "overturemaps.org", q: "Starb" });
  });

  it("sends the collection and the snapped region when given", async () => {
    const { server, client } = setup();
    await client.searchByKeyword({ ...OVERTURE, keyword: "Starb", region: { bbox: [-122.43, 37.77, -122.41, 37.78] } });
    expect(server.requests).toHaveLength(1);
    expect(paramsOf(server.requests[0])).toEqual({ ...OVERTURE, q: "Starb", bbox: "-123,37,-122,38" });
  });

  it("sends a keyword the server cannot use and rejects with the server's KeywordRequired", async () => {
    const { server, client } = setup();
    const outcome = client.searchByKeyword({ dataset: "overturemaps.org", keyword: "a" });
    await expect(outcome).rejects.toBeInstanceOf(AtgeoError);
    await expect(outcome).rejects.toMatchObject({ code: "KeywordRequired" });
    expect(server.requests).toHaveLength(1);
  });
});

describe("searchByKeyword arguments", () => {
  // A call that throws or rejects, with no request sent.
  const refused = async (call: (client: AtgeoClient) => unknown, message: RegExp) => {
    const { server, client } = setup();
    expect(client).toHaveProperty("searchByKeyword");
    const outcome = (async () => call(client))();
    await expect(outcome).rejects.toThrow(TypeError);
    await expect(outcome).rejects.toThrow(message);
    expect(server.requests).toHaveLength(0);
  };
  const circle = { lat: 0, lon: 0, radius: 100 } as never;

  it("refuses a missing dataset first, before the keyword and the region", () =>
    refused((c) => c.searchByKeyword({ keyword: 5, region: circle } as never), /dataset/));

  it("refuses a keyword that is not a string before the region", async () => {
    await refused((c) => c.searchByKeyword({ dataset: "overturemaps.org", keyword: 5, region: circle } as never), /string keyword/);
    await refused((c) => c.searchByKeyword({ dataset: "overturemaps.org", region: circle } as never), /string keyword/);
  });

  it("refuses a circle region", () =>
    refused((c) => c.searchByKeyword({ dataset: "overturemaps.org", keyword: "ab", region: circle }), /region|bbox|circle/i));

  it("refuses a bbox that fails the bbox validation", () =>
    refused((c) => c.searchByKeyword({ dataset: "overturemaps.org", keyword: "ab", region: { bbox: [0, 10, 1, 5] } }), /invalid bbox/));

  it.each([undefined, null])("treats a region of %s as not given", async (region) => {
    const { server, client } = setup();
    await client.searchByKeyword({ dataset: "overturemaps.org", keyword: "ab", region } as never);
    expect(paramsOf(server.requests[0])).not.toHaveProperty("bbox");
  });
});
