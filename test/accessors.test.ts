import { describe, expect, expectTypeOf, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import type { PlaceLocation, PlaceRecord, PlaceValue, SearchHit } from "../src/index.js";
import { OVERTURE, bboxLocation, fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

// Contract section 5: `location.point` is the first usable geo, `location.bbox` the first usable bbox.

const tile = "https://tiles.example/a.json";
const region = { bbox: [-179, -80, 179, 80] as [number, number, number, number] };

type Seen = { name: unknown; location: unknown };

// The fake server validates records against the lexicon, so a value the lexicon rejects (no name, a numeric
// coordinate) is served by swapping it into the answers of a valid placeholder.
function make(value: PlaceValue): typeof fetch {
  const fake = fakeServer({ tilesets: [overture([{ url: tile, records: [record(place("x", "Placeholder", [point(1, 1)]), 1)] }])] });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fake.fetch(input, init);
    const body = await response.json();
    if (Array.isArray(body.records)) body.records[0].value = value;
    else if (body.value) body.value = value;
    return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

// The hit from a search, the record from getPlace on a warm cache, and the record from getPlace on a cold one.
async function seen(value: PlaceValue): Promise<Seen[]> {
  const requests: string[] = [];
  const counting = make(value);
  const warm = new AtgeoClient({
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input).url);
      return counting(input, init);
    }) as typeof fetch,
  });
  const hit = (await warm.searchPlaces({ ...OVERTURE, region })).places[0];
  const before = requests.length;
  const cached = await warm.getPlace({ origin: placeOrigin("x") });
  // The warm getPlace is answered from the cache: no request of any kind.
  expect(requests.length).toBe(before);
  const network = await new AtgeoClient({ fetch: make(value) }).getPlace({ origin: placeOrigin("x") });
  return [hit, cached, network] as unknown as Seen[];
}

const allThree = async (value: PlaceValue, check: (s: Seen) => void) => {
  const results = await seen(value);
  expect(results).toHaveLength(3);
  results.forEach(check);
};

const geo = (latitude: unknown, longitude: unknown) => ({ $type: "community.lexicon.location.geo", latitude, longitude });
const box = (south: unknown, north: unknown, west: unknown, east: unknown) => ({
  $type: "community.lexicon.location.bbox",
  south,
  north,
  west,
  east,
});

describe("name", () => {
  it("is the place's name", async () => {
    await allThree(place("x", "Zanzibar", [point(10, 20)]), (s) => expect(s.name).toBe("Zanzibar"));
  });

  it("is null when the name is absent", async () => {
    await allThree(place("x", "ignored", [point(10, 20)], { name: undefined }), (s) => expect(s.name).toBeNull());
  });

  it("is null when the name is not a string", async () => {
    await allThree(place("x", "ignored", [point(10, 20)], { name: 42 }), (s) => expect(s.name).toBeNull());
  });
});

describe("location", () => {
  it("holds the point and the box", async () => {
    await allThree(place("x", "P", [point(10.5, 20.25), bboxLocation(12, 8, 22, 18)]), (s) =>
      expect(s.location).toEqual({
        point: { lat: 10.5, lon: 20.25 },
        bbox: { south: 8, west: 18, north: 12, east: 22 },
      }),
    );
  });

  it("is null for what the place lacks", async () => {
    await allThree(place("x", "P", [point(10, 20)]), (s) =>
      expect(s.location).toEqual({ point: { lat: 10, lon: 20 }, bbox: null }),
    );
    await allThree(place("x", "P", [bboxLocation(12, 8, 22, 18)]), (s) =>
      expect(s.location).toEqual({ point: null, bbox: { south: 8, west: 18, north: 12, east: 22 } }),
    );
  });

  it("takes the first usable geo and the first usable bbox, skipping unusable ones; numbers may be JSON numbers", async () => {
    const value = place("x", "P", [
      geo("abc", "1"),
      geo([0.5], 2),
      box("1", "2", "3", null),
      geo(10, "20.5"),
      box(-5, 5, 170, -170),
      geo("30", "40"),
      box("1", "2", "3", "4"),
    ]);
    await allThree(value, (s) =>
      expect(s.location).toEqual({
        point: { lat: 10, lon: 20.5 },
        bbox: { south: -5, west: 170, north: 5, east: -170 },
      }),
    );
  });

  it("keeps an antimeridian box as given, west greater than east", async () => {
    await allThree(place("x", "P", [bboxLocation(10, -10, -170, 170)]), (s) =>
      expect(s.location).toEqual({ point: null, bbox: { south: -10, west: 170, north: 10, east: -170 } }),
    );
  });

  it("is frozen, with its point and box", async () => {
    await allThree(place("x", "P", [point(10, 20), bboxLocation(12, 8, 22, 18)]), (s) => {
      const location = s.location as { point: object; bbox: object };
      expect(Object.isFrozen(location)).toBe(true);
      expect(Object.isFrozen(location.point)).toBe(true);
      expect(Object.isFrozen(location.bbox)).toBe(true);
    });
  });
});

describe("types", () => {
  it("gives SearchHit and PlaceRecord a required name and location", () => {
    expectTypeOf<SearchHit["name"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PlaceRecord["name"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SearchHit["location"]>().toEqualTypeOf<PlaceLocation>();
    expectTypeOf<PlaceRecord["location"]>().toEqualTypeOf<PlaceLocation>();
    expectTypeOf<PlaceLocation>().toEqualTypeOf<{
      point: { lat: number; lon: number } | null;
      bbox: { south: number; west: number; north: number; east: number } | null;
    }>();
    expectTypeOf<SearchHit>().toHaveProperty("name");
    expectTypeOf<SearchHit>().toHaveProperty("location");
    expectTypeOf<PlaceRecord>().toHaveProperty("name");
    expectTypeOf<PlaceRecord>().toHaveProperty("location");
  });
});
