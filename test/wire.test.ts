import { describe, expect, it } from "vitest";
import fixture from "../fixtures/lenient-readers.json" with { type: "json" };
import { DecodingError } from "../src/index.js";
import { readPlace, readServiceDescription, readTileList, readTilePayload, readTileset } from "../src/wire.js";

// The lenient readers against fixtures/lenient-readers.json, which the ports vendor (contract section 1).
// An absent field is a missing key, so the comparison is strict.
const readers: Record<string, (body: unknown) => unknown> = {
  getTiles: readTileList,
  tilePayload: readTilePayload,
  getPlace: readPlace,
  describeService: readServiceDescription,
  describeTileset: readTileset,
};

type Case = { reader: string; name: string; body: unknown; result?: unknown; decodingError?: true };
const cases = fixture as Case[];

describe("lenient readers", () => {
  it("has a case for every reader", () => {
    expect([...new Set(cases.map((c) => c.reader))].sort()).toEqual(Object.keys(readers).sort());
  });

  it.each(cases.map((c) => [`${c.reader}: ${c.name}`, c] as const))("%s", (_label, c) => {
    const read = readers[c.reader];
    if (c.decodingError) {
      expect(() => read(c.body)).toThrow(DecodingError);
    } else {
      expect(read(c.body)).toStrictEqual(c.result);
    }
  });
});

describe("DecodingError", () => {
  it("is an Error with its own name, and not an AtgeoError", () => {
    const error = new DecodingError("no usable body");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DecodingError");
    expect(error.message).toBe("no usable body");
  });
});
