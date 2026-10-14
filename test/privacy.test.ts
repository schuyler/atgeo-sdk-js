import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { fakeServer, overture, place, point, record } from "./helpers/fakeServer.js";

const TILE = "https://tiles.example/t1.json";

function setup() {
  const server = fakeServer({
    tilesets: [overture([{ url: TILE, records: [record(place("r1", "Zanzibar Quokka Cafe", [point(37.775, -122.418)]))] }])],
  });
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

const wire = (requests: { url: string; headers: Record<string, string>; body: string | null }[]) =>
  requests.flatMap((r) => {
    const raw = JSON.stringify([r.url, r.headers, r.body]);
    const decoded = (() => {
      try {
        return decodeURIComponent(r.url) + JSON.stringify(r.headers) + (r.body ?? "");
      } catch {
        return raw;
      }
    })();
    return [raw.toLowerCase(), decoded.toLowerCase()];
  });

describe("search text stays local", () => {
  const texts = ["Zanzibar Quokka", "  ZANZIBÁR   quokka ", "Zanzibar"];

  it.each(texts)("does not put %j on the wire", async (text) => {
    const { server, client } = setup();
    await client.searchPlaces({
      region: { lat: 37.7749295, lon: -122.4194155, radius: 500 },
      text,
    });
    expect(server.requests.length).toBeGreaterThan(0);
    const normalized = "zanzibar quokka";
    const needles = [text.toLowerCase(), text.trim().toLowerCase(), normalized, ...normalized.split(" "), "zanzib", "quokka"];
    for (const haystack of wire(server.requests)) {
      for (const needle of needles) expect(haystack).not.toContain(needle);
      expect(haystack).not.toContain(encodeURIComponent(text).toLowerCase());
    }
  });

  it("issues only getTiles and tile requests", async () => {
    const { server, client } = setup();
    await client.searchPlaces({
      region: { lat: 37.7749295, lon: -122.4194155, radius: 500 },
      text: "Zanzibar Quokka",
    });
    const kinds = server.requests.map((r) =>
      r.url.includes("/xrpc/org.atgeo.getTiles?") ? "tiles" : r.url === TILE ? "tile" : r.url,
    );
    expect(kinds).toEqual(["tiles", "tile"]);
    for (const r of server.requests) expect(r.method).toBe("GET");
  });

  it("sends no body", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region: { bbox: [-122.43, 37.77, -122.41, 37.78] }, text: "Zanzibar Quokka" });
    expect(server.requests.length).toBeGreaterThan(0);
    for (const r of server.requests) expect(r.body).toBeNull();
  });
});

describe("precise coordinates stay local", () => {
  it("keeps the circle centre off the wire", async () => {
    const { server, client } = setup();
    await client.searchPlaces({
      region: { lat: 37.7749295, lon: -122.4194155, radius: 123.456789 },
      text: "Zanzibar Quokka",
    });
    expect(server.requests.length).toBeGreaterThan(0);
    for (const h of wire(server.requests)) {
      for (const needle of ["37.7749295", "122.4194155", "7749295", "4194155", "123.456789"]) {
        expect(h).not.toContain(needle);
      }
    }
  });

  it("keeps full-precision bbox corners off the wire", async () => {
    const { server, client } = setup();
    await client.searchPlaces({ region: { bbox: [-122.4194155, 37.7749295, -122.4094155, 37.7849295] } });
    expect(server.requests.length).toBeGreaterThan(0);
    for (const h of wire(server.requests)) {
      for (const needle of ["7749295", "4194155", "4094155", "7849295"]) expect(h).not.toContain(needle);
    }
  });
});
