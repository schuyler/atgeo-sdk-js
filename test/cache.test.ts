import { afterEach, describe, expect, it, vi } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { PLACES, fakeServer, place, point } from "./helpers/fakeServer.js";

const url = (n: string) => `https://tiles.example/${n}.json`;
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const OTHER = "org.atgeo.places.other";

function setup() {
  const server = fakeServer({
    collections: {
      [PLACES]: {
        tiles: [
          {
            url: url("a"),
            records: [
              place("a", "Alpha", [point(37.772, -122.412)], { importance: 3 }),
              place("shared", "Shared in A", [point(37.773, -122.413)], { importance: 2 }),
            ],
          },
        ],
        metadata: { collection: PLACES },
      },
      [OTHER]: {
        tiles: [{ url: url("o"), records: [place("shared", "Shared in other", [point(10, 10)])] }],
      },
    },
  });
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

const coverageCount = (requests: { url: string }[]) =>
  requests.filter((r) => r.url.includes("org.atgeo.getCoverage")).length;

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

describe("coverage expiry", () => {
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
    expect(coverageCount(server.requests)).toBe(2);
    expect(server.requests.filter((r) => r.url === url("a"))).toHaveLength(1);
  });

  it("fails offline once coverage has expired", async () => {
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
    const record = await client.getPlace({ collection: PLACES, rkey: "a" });
    expect(server.requests.length).toBe(before);
    expect(record.uri).toBe(`https://places.atgeo.org/${PLACES}/a`);
    expect(record.place).toEqual(place("a", "Alpha", [point(37.772, -122.412)], { importance: 3 }));
  });

  it("answers offline for a cached rkey", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region });
    server.goOffline();
    await expect(client.getPlace({ collection: PLACES, rkey: "shared" })).resolves.toMatchObject({
      place: { name: "Shared in A" },
    });
  });

  it("scopes the scan to the requested collection", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region });
    const before = server.requests.length;
    const record = await client.getPlace({ collection: OTHER, rkey: "shared" });
    const getRecords = server.requests
      .slice(before)
      .map((r) => new URL(r.url))
      .filter((u) => u.pathname === "/xrpc/com.atproto.repo.getRecord");
    expect(getRecords).toHaveLength(1);
    expect(getRecords[0].searchParams.get("collection")).toBe(OTHER);
    expect(record.place.name).toBe("Shared in other");
  });
});
