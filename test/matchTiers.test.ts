import { describe, expect, it } from "vitest";
import fixture from "../fixtures/match-tiers.json" with { type: "json" };
import { normalize } from "../src/normalize.js";
import { matchTier } from "../src/rank.js";
import type { PlaceValue } from "../src/index.js";

interface Case {
  name: string;
  query: string;
  place: { name: string; variants?: { name: string }[] };
  tier: 1 | 2;
}

const cases = fixture as unknown as Case[];

describe("match tiers", () => {
  it.each(cases)("$name", ({ query, place, tier }) => {
    const value: PlaceValue = { name: place.name, ...(place.variants ? { variants: place.variants } : {}) };
    expect(matchTier(normalize(query), value)).toBe(tier);
  });
});
