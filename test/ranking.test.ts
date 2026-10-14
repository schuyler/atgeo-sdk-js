import { describe, expect, it } from "vitest";
import fixture from "../fixtures/ranking-scenarios.json" with { type: "json" };
import { AtgeoClient } from "../src/index.js";
import type { PlaceValue, Region, SortMode } from "../src/index.js";
import { fakeServer, overture, record } from "./helpers/fakeServer.js";

interface Scenario {
  name: string;
  description: string;
  region: Region;
  text?: string;
  sort?: SortMode;
  records: { value: PlaceValue; importance: number }[];
  expect: { top: { k: number; origins: string[] }[]; absent?: string[] };
}

const scenarios = fixture as unknown as Scenario[];

describe("ranking scenarios", () => {
  it.each(scenarios)("$name", async (s) => {
    const { fetch } = fakeServer({
      tilesets: [
        overture([
          { url: "https://places.atgeo.org/tiles/t0.json", records: s.records.map((r) => record(r.value, r.importance)) },
        ]),
      ],
    });
    const { places } = await new AtgeoClient({ fetch }).searchPlaces({
      region: s.region,
      text: s.text,
      sort: s.sort,
    });
    const origins = places.map((p) => p.origin);

    for (const { k, origins: wanted } of s.expect.top) {
      for (const origin of wanted) expect(origins.slice(0, k)).toContain(origin);
    }
    for (const origin of s.expect.absent ?? []) expect(origins).not.toContain(origin);
    if (s.expect.top.length === 0) expect(origins).toEqual([]);
  });
});
