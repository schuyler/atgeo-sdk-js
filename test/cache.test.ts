import { afterEach, describe, expect, it, vi } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { OVERTURE, fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

const url = (n: string) => `https://tiles.example/${n}.json`;
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const OTHER_ORIGIN = "urn:atgeo:example.org:thing:shared";

function setup() {
  const server = fakeServer({
    tilesets: [
      overture([
        {
          url: url("a"),
          records: [
            record(place("a", "Alpha", [point(37.772, -122.412)]), 3),
            record(place("shared", "Shared in A", [point(37.773, -122.413)]), 2),
          ],
        },
      ]),
      {
        slug: "example-thing",
        collections: [{ dataset: "example.org", collection: "thing" }],
        tiles: [
          {
            url: url("o"),
            records: [record(place("shared", "Shared in other", [point(10, 10)], { origin: OTHER_ORIGIN }))],
          },
        ],
      },
    ],
  });
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

const tileListCount = (requests: { url: string }[]) =>
  requests.filter((r) => r.url.includes("org.atgeo.getTiles")).length;

afterEach(() => {
  vi.useRealTimers();
});

describe("warm regions", () => {
  it("answers an identical second search offline", async () => {
    const { server, client } = setup();
    const first = await client.searchPlaces({ ...OVERTURE, region, text: "Alpha" });
    server.goOffline();
    const second = await client.searchPlaces({ ...OVERTURE, region, text: "Alpha" });
    expect(second).toEqual(first);
    expect(first.places.length).toBeGreaterThan(0);
  });

  it("reuses tiles for a different text over the same region", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ ...OVERTURE, region });
    const before = server.requests.length;
    await client.searchPlaces({ ...OVERTURE, region, text: "Alpha" });
    expect(server.requests.length).toBe(before);
  });

  it("makes no tile request for a repeated search", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ ...OVERTURE, region });
    await client.searchPlaces({ ...OVERTURE, region });
    expect(server.requests.filter((r) => r.url === url("a"))).toHaveLength(1);
  });
});

describe("attribution in the tile cache", () => {
  it("gives a warm offline search the same, non-empty attribution and hit collections", async () => {
    const { server, client } = setup();
    const first = await client.searchPlaces({ ...OVERTURE, region });
    expect(first.attribution.length).toBeGreaterThan(0);
    expect(first.places.length).toBeGreaterThan(0);
    for (const hit of first.places) expect(hit.collection).toStrictEqual({ dataset: "overturemaps.org", collection: "place" });
    server.goOffline();
    const second = await client.searchPlaces({ ...OVERTURE, region });
    expect(second.attribution).toStrictEqual(first.attribution);
    expect(second.places.map((h) => h.collection)).toStrictEqual(first.places.map((h) => h.collection));
  });

  it("builds a search's attribution only from its own tiles, though another tile is still cached", async () => {
    const entryA = { dataset: "ref-a.example", collection: "c" };
    const entryB = { dataset: "ref-b.example", collection: "c" };
    const server = fakeServer({
      tilesets: [
        { ...overture([{ url: url("a"), records: [record(place("pa", "A", [point(37.775, -122.415)]))] }]), references: [entryA] },
        {
          slug: "overture-place-b",
          collections: [{ dataset: "overturemaps.org", collection: "place" }],
          references: [entryB],
          tiles: [{ url: url("b"), records: [record(place("pb", "B", [point(10.55, -100.45)]))] }],
        },
      ],
      tilesFor: (bbox) => [bbox.startsWith("-122") ? url("a") : url("b")],
    });
    const client = new AtgeoClient({ fetch: server.fetch });
    const place_ = { dataset: "overturemaps.org", collection: "place" };
    const a = await client.searchPlaces({ ...OVERTURE, region });
    const b = await client.searchPlaces({ ...OVERTURE, region: { bbox: [-100.5, 10.5, -100.4, 10.6] } });
    expect(a.attribution).toStrictEqual([place_, entryA]);
    expect(b.attribution).toStrictEqual([place_, entryB]);
  });
});

describe("tile-list expiry", () => {
  it("expires after 3600 s and then requires network", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { server, client } = setup();
    await client.searchPlaces({ ...OVERTURE, region });
    const base = server.requests.length;

    vi.setSystemTime(new Date("2026-01-01T00:59:59Z"));
    await client.searchPlaces({ ...OVERTURE, region });
    expect(server.requests.length).toBe(base);

    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    await client.searchPlaces({ ...OVERTURE, region });
    expect(tileListCount(server.requests)).toBe(2);
    expect(server.requests.filter((r) => r.url === url("a"))).toHaveLength(1);
  });

  it("fails offline once the tile list has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { server, client } = setup();
    await client.searchPlaces({ ...OVERTURE, region });
    server.goOffline();
    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    await expect(client.searchPlaces({ ...OVERTURE, region })).rejects.toThrow();
  });

  it("caches describeService for 3600 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { server, client } = setup();
    await client.describeService();
    vi.setSystemTime(new Date("2026-01-01T00:59:59Z"));
    await client.describeService();
    expect(server.requests).toHaveLength(1);
    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    await client.describeService();
    expect(server.requests).toHaveLength(2);
  });
});

describe("getPlace cache scan", () => {
  it("answers from an already-fetched tile without a request", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ ...OVERTURE, region });
    const before = server.requests.length;
    const found = await client.getPlace({ origin: placeOrigin("a") });
    expect(server.requests.length).toBe(before);
    expect(found).toEqual({
      origin: placeOrigin("a"),
      place: place("a", "Alpha", [point(37.772, -122.412)]),
      importance: 3,
      attribution: [{ dataset: "overturemaps.org", collection: "place" }],
    });
  });

  it("answers offline for a cached origin", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ ...OVERTURE, region });
    server.goOffline();
    await expect(client.getPlace({ origin: placeOrigin("shared") })).resolves.toMatchObject({
      place: { name: "Shared in A" },
    });
  });

  it("matches the whole origin, not a shared id", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ ...OVERTURE, region });
    const before = server.requests.length;
    const found = await client.getPlace({ origin: OTHER_ORIGIN });
    const getPlaces = server.requests.slice(before).map((r) => new URL(r.url)).filter((u) => u.pathname === "/xrpc/org.atgeo.getPlace");
    expect(getPlaces).toHaveLength(1);
    expect(getPlaces[0].searchParams.get("uri")).toBe(OTHER_ORIGIN);
    expect(found.place.name).toBe("Shared in other");
  });

  it("takes the attribution of the lowest-URL tile, as served, though higher ones were cached before and after it", async () => {
    const references = [
      { dataset: "z.example", collection: "c" },
      { dataset: "a.example", collection: "c", release: "1" },
      { dataset: "a.example", collection: "c", release: "2" },
    ];
    const copy = () => record(place("x", "Copy", [point(37.775, -122.415)]));
    const server = fakeServer({
      tilesets: [
        { ...overture([{ url: url("a"), records: [copy()] }]), references },
        {
          slug: "overture-place-b",
          collections: [{ dataset: "overturemaps.org", collection: "place" }],
          references: [{ dataset: "b.example", collection: "c" }],
          tiles: [{ url: url("b"), records: [copy()] }],
        },
        {
          slug: "overture-place-c",
          collections: [{ dataset: "overturemaps.org", collection: "place" }],
          references: [{ dataset: "c.example", collection: "c" }],
          tiles: [{ url: url("c"), records: [copy()] }],
        },
      ],
      tilesFor: (bbox) => [bbox.startsWith("-122") ? url("a") : bbox.startsWith("-100") ? url("b") : url("c")],
    });
    const client = new AtgeoClient({ fetch: server.fetch });
    // b, then a, then c: the lowest URL is neither the first nor the last cached.
    await client.searchPlaces({ ...OVERTURE, region: { bbox: [-100.5, 10.5, -100.4, 10.6] } });
    await client.searchPlaces({ ...OVERTURE, region });
    await client.searchPlaces({ ...OVERTURE, region: { bbox: [-90.5, 10.5, -90.4, 10.6] } });
    server.goOffline();
    const answer = await client.getPlace({ origin: placeOrigin("x") });
    expect(answer.attribution).toStrictEqual([{ dataset: "overturemaps.org", collection: "place" }, ...references]);
  });

  it.each([
    ["no attribution", undefined],
    ["an attribution that is an object", {}],
    ["an attribution that is null", null],
    ["an attribution that is a string", "x"],
  ])("gives an empty attribution from a tile with %s", async (_name, attribution) => {
    const value = place("x", "Plain", [point(37.775, -122.415)]);
    const requests: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      const href = new Request(input).url;
      requests.push(href);
      if (href.includes("getTiles")) return new Response(JSON.stringify({ tiles: [url("raw")] }));
      return new Response(JSON.stringify({ records: [{ value, importance: 3 }], ...(attribution === undefined ? {} : { attribution }) }));
    }) as typeof globalThis.fetch;
    const client = new AtgeoClient({ fetch });
    const { places } = await client.searchPlaces({ ...OVERTURE, region });
    expect(places).toHaveLength(1);
    expect(places[0].collection).toBeNull();
    const before = requests.length;
    expect(await client.getPlace({ origin: placeOrigin("x") })).toStrictEqual({
      origin: placeOrigin("x"),
      place: value,
      importance: 3,
      attribution: [],
    });
    expect(requests.length).toBe(before);
  });

  it("returns the copy from the lowest tile URL, although a higher one was cached first", async () => {
    const copy = (name: string) => record(place("x", name, [point(37.775, -122.415)]));
    const server = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [copy("Copy A")] }, { url: url("b"), records: [copy("Copy B")] }])],
      tilesFor: (bbox) => [bbox.startsWith("-122") ? url("a") : url("b")],
    });
    const client = new AtgeoClient({ fetch: server.fetch });
    await client.searchPlaces({ ...OVERTURE, region: { bbox: [-100.5, 10.5, -100.4, 10.6] } });
    expect((await client.getPlace({ origin: placeOrigin("x") })).place.name).toBe("Copy B");
    await client.searchPlaces({ ...OVERTURE, region });
    server.goOffline();
    expect((await client.getPlace({ origin: placeOrigin("x") })).place.name).toBe("Copy A");
  });
});
