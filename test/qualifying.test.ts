import { describe, expect, it } from "vitest";
import fixture from "../fixtures/qualifying-keywords.json" with { type: "json" };
import { qualifies } from "../src/rank.js";

// fixtures/qualifying-keywords.json: the qualifying predicate of contract section 17, which decides whether the
// fallback and the autocompleter send a keyword. Language-neutral, so every port runs the same cases (#60).
describe("qualifying keywords", () => {
  it.each(fixture)("$name: $keyword → $qualifies", ({ keyword, qualifies: expected }) => {
    expect(qualifies(keyword)).toBe(expected);
  });
});
