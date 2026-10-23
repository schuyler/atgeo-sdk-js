import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import type { PlaceValue } from "../src/index.js";
import { fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

// `place` on a hit or a getPlace answer is the object the tile cache holds, so it is frozen (shallowly)
// when parsed. Test files are ES modules, so a write to a frozen object throws here, as it does for an app.

const tile = "https://tiles.example/a.json";
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const origin = placeOrigin("cafe");

const makeValue = () =>
  place("cafe", "Zanzibar Cafe", [point(37.775, -122.415)], {
    variants: [{ name: "Zanzibar" }],
    attributes: { kind: "cafe", tags: ["coffee"] },
  });

function setup() {
  const fake = fakeServer({ tilesets: [overture([{ url: tile, records: [record(makeValue(), 5)] }])] });
  return { fake, client: new AtgeoClient({ fetch: fake.fetch }) };
}

const firstHit = async (client: AtgeoClient) => (await client.searchPlaces({ region })).places[0];

describe("a search hit's place", () => {
  it("is frozen, and assigning, deleting or defining a property throws", async () => {
    const hit = await firstHit(setup().client);
    expect(Object.isFrozen(hit.place)).toBe(true);
    expect(() => {
      hit.place.name = "Changed";
    }).toThrow(TypeError);
    expect(() => {
      hit.place.extra = 1;
    }).toThrow(TypeError);
    expect(() => {
      delete hit.place.attributes;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(hit.place, "name", { value: "Changed" })).toThrow(TypeError);
    expect(() => Object.defineProperty(hit.place, "added", { value: 1 })).toThrow(TypeError);
    expect(hit.place).toEqual(makeValue());
  });

  it("leaves a later search over the same cached tile, and getPlace from the cache, unchanged", async () => {
    const { fake, client } = setup();
    const hit = await firstHit(client);
    try {
      hit.place.name = "Changed";
      delete hit.place.attributes;
    } catch {
      // expected: the place is frozen
    }
    const again = await firstHit(client);
    expect(again.place).toBe(hit.place); // same cached object, still intact
    expect(again.place).toEqual(makeValue());
    expect((await client.getPlace({ origin })).place).toEqual(makeValue());
    expect(fake.requests.filter((r) => r.url === tile)).toHaveLength(1);
  });

  it("is the same object getPlace returns from the cache, so that one is frozen too", async () => {
    const { client } = setup();
    const hit = await firstHit(client);
    const { place: cached } = await client.getPlace({ origin });
    expect(cached).toBe(hit.place);
    expect(Object.isFrozen(cached)).toBe(true);
    expect(() => {
      cached.name = "Changed";
    }).toThrow(TypeError);
  });

  it("copies into something mutable with structuredClone, deeply", async () => {
    const hit = await firstHit(setup().client);
    const copy = structuredClone(hit.place) as { name: string; variants: { name: string }[]; attributes?: unknown };
    expect(Object.isFrozen(copy)).toBe(false);
    copy.name = "Mine";
    copy.variants.push({ name: "More" });
    delete copy.attributes;
    expect(copy.name).toBe("Mine");
    expect(hit.place).toEqual(makeValue());
  });

  it("copies into a mutable top level with a spread, sharing the nested values", async () => {
    const hit = await firstHit(setup().client);
    const copy = { ...hit.place };
    expect(Object.isFrozen(copy)).toBe(false);
    copy.name = "Mine";
    expect(copy.name).toBe("Mine");
    expect(hit.place.name).toBe("Zanzibar Cafe");
    expect(copy.variants).toBe(hit.place.variants);
  });

  // Pins the limit of the shallow freeze: nested values are shared with the cache and stay mutable. If
  // this ever starts throwing, the freeze got deeper, and the README and docs/port-contract.md change with it.
  it("does not stop a change to a nested object or array, which the cache shares", async () => {
    const { client } = setup();
    const hit = await firstHit(client);
    const nested = hit.place as { attributes: { kind: string }; variants: { name: string }[] };
    expect(Object.isFrozen(nested.attributes)).toBe(false);
    expect(Object.isFrozen(nested.variants)).toBe(false);
    nested.attributes.kind = "changed";
    nested.variants.push({ name: "Added" });
    const again = (await firstHit(client)).place as typeof nested;
    expect(again.attributes.kind).toBe("changed");
    expect(again.variants).toHaveLength(2);
  });
});

describe("getPlace from the network", () => {
  it("returns a frozen place", async () => {
    const { fake, client } = setup();
    const { place: fetched } = await client.getPlace({ origin });
    expect(fake.requests.some((r) => r.url.includes("org.atgeo.getPlace"))).toBe(true);
    expect(Object.isFrozen(fetched)).toBe(true);
    expect(() => {
      fetched.name = "Changed";
    }).toThrow(TypeError);
    expect(fetched).toEqual(makeValue());
    const copy: PlaceValue = structuredClone(fetched);
    copy.name = "Mine";
    expect(copy.name).toBe("Mine");
  });
});
