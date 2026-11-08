import { describe, expect, it } from "vitest";
import { AtgeoClient } from "../src/index.js";
import { OVERTURE, fakeServer, overture, place, placeOrigin, point, record } from "./helpers/fakeServer.js";

const tiles = [{ url: "https://tiles.example/p.json", records: [record(place("zc", "Zanzibar Cafe", [point(37.775, -122.418)]), 5)] }];
const nothing = { places: [], attribution: [], disclosed: { keyword: false, region: null } };

function setup() {
  const server = fakeServer({ tilesets: [overture(tiles)] });
  return { server, client: new AtgeoClient({ fetch: server.fetch }) };
}

describe("autocompleteByKeyword", () => {
  // A one-character prefix, a Hangul syllable (one character, though NFKD makes it two), and a consonant
  // with a spacing vowel sign (one character once the sign is stripped).
  it.each(["a", "하", "का"])("makes no request for %j and resolves an empty result that disclosed nothing", async (prefix) => {
    const { server, client } = setup();
    const result = await client.autocompleteByKeyword(OVERTURE).searchByKeyword(prefix);
    expect(result).toEqual(nothing);
    expect(server.requests).toHaveLength(0);
  });

  it("sends a prefix that qualifies, as typed, and returns the keyword hits", async () => {
    const { server, client } = setup();
    const result = await client.autocompleteByKeyword(OVERTURE).searchByKeyword("Zan");
    expect(server.requests).toHaveLength(1);
    expect(Object.fromEntries(new URL(server.requests[0].url).searchParams)).toEqual({ ...OVERTURE, q: "Zan" });
    expect(result.places.map((h) => h.origin)).toEqual([placeOrigin("zc")]);
  });

  it("aborts the previous call on the same autocompleter, which rejects with an AbortError", async () => {
    const { server } = setup();
    let calls = 0;
    // The first request waits for its signal; the second goes to the fake.
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      ++calls > 1
        ? server.fetch(input, init)
        : new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
          )) as typeof globalThis.fetch;
    const autocompleter = new AtgeoClient({ fetch }).autocompleteByKeyword(OVERTURE);
    const first = autocompleter.searchByKeyword("Za");
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = await autocompleter.searchByKeyword("Zan");
    await rejected;
    expect(second.places).toHaveLength(1);
  });
});

describe("autocompleteByKeyword arguments", () => {
  it("is a method of the client", () => {
    expect(setup().client).toHaveProperty("autocompleteByKeyword");
  });

  it("refuses a missing dataset at construction", () => {
    const { client } = setup();
    expect(() => client.autocompleteByKeyword({} as never)).toThrow(TypeError);
    expect(() => client.autocompleteByKeyword({} as never)).toThrow(/dataset/);
  });

  it("refuses a circle region at construction", () => {
    const { client } = setup();
    expect(client).toHaveProperty("autocompleteByKeyword");
    expect(() => client.autocompleteByKeyword({ ...OVERTURE, region: { lat: 0, lon: 0, radius: 100 } } as never)).toThrow(/region|bbox|circle/i);
  });

  it("refuses a keyword that is not a string, with no request", async () => {
    const { server, client } = setup();
    const autocompleter = client.autocompleteByKeyword(OVERTURE);
    expect(autocompleter).toHaveProperty("searchByKeyword");
    await expect((async () => autocompleter.searchByKeyword(5 as never))()).rejects.toThrow(TypeError);
    expect(server.requests).toHaveLength(0);
  });
});
