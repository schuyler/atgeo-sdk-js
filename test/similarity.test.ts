import { describe, expect, it } from "vitest";
import fixture from "../fixtures/jaro-winkler.json" with { type: "json" };
import { jaroWinkler } from "../src/similarity.js";

const cases: { a: string; b: string; score: number }[] = fixture;

describe("jaroWinkler", () => {
  it.each(cases)("scores $a / $b", ({ a, b, score }) => {
    expect(jaroWinkler(a, b)).toBeCloseTo(score, 6);
  });

  it.each(cases)("is symmetric for $a / $b", ({ a, b }) => {
    expect(jaroWinkler(a, b)).toBe(jaroWinkler(b, a));
  });
});
