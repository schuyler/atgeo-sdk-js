import { describe, expect, it } from "vitest";
import fixture from "../fixtures/normalize.json" with { type: "json" };
import { normalize } from "../src/normalize.js";

const cases: { input: string; expected: string }[] = fixture;

describe("normalize", () => {
  it.each(cases)("normalizes $input", ({ input, expected }) => {
    expect(normalize(input)).toBe(expected);
  });
});
