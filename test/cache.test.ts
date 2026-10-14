import { afterEach, describe, expect, it, vi } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

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
    const first = await client.searchPlaces({ region, text: "Alpha" });
    server.goOffline();
    const second = await client.searchPlaces({ region, text: "Alpha" });
    expect(second).toEqual(first);
    expect(first.places.length).toBeGreaterThan(0);
  });

  it("reuses tiles for a different text over the same region", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region });
    const before = server.requests.length;
    await client.searchPlaces({ region, text: "Alpha" });
    expect(server.requests.length).toBe(before);
  });

  it("makes no tile request for a repeated search", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region });
    await client.searchPlaces({ region });
    expect(server.requests.filter((r) => r.url === url("a"))).toHaveLength(1);
  });
});

describe("tile-list expiry", () => {
  it("expires after 3600 s and then requires network", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { server, client } = setup();
    await client.searchPlaces({ region });
    const base = server.requests.length;

    vi.setSystemTime(new Date("2026-01-01T00:59:59Z"));
    await client.searchPlaces({ region });
    expect(server.requests.length).toBe(base);

    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    await client.searchPlaces({ region });
    expect(tileListCount(server.requests)).toBe(2);
    expect(server.requests.filter((r) => r.url === url("a"))).toHaveLength(1);
  });

  it("fails offline once the tile list has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { server, client } = setup();
    await client.searchPlaces({ region });
    server.goOffline();
    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    await expect(client.searchPlaces({ region })).rejects.toThrow();
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
    await client.searchPlaces({ region });
    const before = server.requests.length;
    const found = await client.getPlace({ origin: placeOrigin("a") });
    expect(server.requests.length).toBe(before);
    expect(found).toEqual({
      origin: placeOrigin("a"),
      place: place("a", "Alpha", [point(37.772, -122.412)]),
      importance: 3,
    });
  });

  it("answers offline for a cached origin", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region });
    server.goOffline();
    await expect(client.getPlace({ origin: placeOrigin("shared") })).resolves.toMatchObject({
      place: { name: "Shared in A" },
    });
  });

  it("matches the whole origin, not a shared id", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region });
    const before = server.requests.length;
    const found = await client.getPlace({ origin: OTHER_ORIGIN });
    const getPlaces = server.requests.slice(before).map((r) => new URL(r.url)).filter((u) => u.pathname === "/xrpc/org.atgeo.getPlace");
    expect(getPlaces).toHaveLength(1);
    expect(getPlaces[0].searchParams.get("uri")).toBe(OTHER_ORIGIN);
    expect(found.place.name).toBe("Shared in other");
  });

  it("returns the copy from the lowest tile URL, although a higher one was cached first", async () => {
    const copy = (name: string) => record(place("x", name, [point(37.775, -122.415)]));
    const server = fakeServer({
      tilesets: [overture([{ url: url("a"), records: [copy("Copy A")] }, { url: url("b"), records: [copy("Copy B")] }])],
      tilesFor: (bbox) => [bbox.startsWith("-122") ? url("a") : url("b")],
    });
    const client = new AtgeoClient({ fetch: server.fetch });
    await client.searchPlaces({ region: { bbox: [-100.5, 10.5, -100.4, 10.6] } });
    expect((await client.getPlace({ origin: placeOrigin("x") })).place.name).toBe("Copy B");
    await client.searchPlaces({ region });
    server.goOffline();
    expect((await client.getPlace({ origin: placeOrigin("x") })).place.name).toBe("Copy A");
  });
});
