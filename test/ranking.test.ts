import { describe, expect, it } from "vitest";
import fixture from "../fixtures/ranking-scenarios.json" with { type: "json" };
import { AtgeoClient } from "../src/index.js";
import type { PlaceValue, Region, SortMode } from "../src/index.js";
import { fakeServer, PLACES } from "./helpers/fakeServer.js";

interface Scenario {
  name: string;
  description: string;
  region: Region;
  text?: string;
  sort?: SortMode;
  records: PlaceValue[];
  expect: { top: { k: number; rkeys: string[] }[]; absent?: string[] };
}

const scenarios = fixture as unknown as Scenario[];

describe("ranking scenarios", () => {
  it.each(scenarios)("$name", async (s) => {
    const { fetch } = fakeServer({
      collections: { [PLACES]: { tiles: [{ url: "https://places.atgeo.org/tiles/t0.json", records: s.records }] } },
    });
    const { places } = await new AtgeoClient({ fetch }).searchPlaces({
      region: s.region,
      text: s.text,
      sort: s.sort,
    });
    const rkeys = places.map((p) => p.place.rkey);

    for (const { k, rkeys: wanted } of s.expect.top) {
      for (const rkey of wanted) expect(rkeys.slice(0, k)).toContain(rkey);
    }
    for (const rkey of s.expect.absent ?? []) expect(rkeys).not.toContain(rkey);
    if (s.expect.top.length === 0) expect(rkeys).toEqual([]);
  });
});
