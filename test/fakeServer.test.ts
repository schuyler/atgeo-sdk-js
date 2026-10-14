import { describe, expect, it } from "vitest";
import { fakeServer, overture, place, point, record, type FakeTileset } from "./helpers/fakeServer.js";

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

  it("answers describeService with a did and tilesets", async () => {
    const body = await (await get(build([]), "/xrpc/org.atgeo.describeService")).json();
    expect(body).toEqual({
      did: "did:web:places.atgeo.org",
      tilesets: [{ slug: "overture-place", collections: [{ dataset: "overturemaps.org", collection: "place" }] }],
    });
  });
});
