import { describe, expect, it, vi } from "vitest";
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

// Contract section 19 (#56): a keyword the SDK judged qualifying but the server refuses with KeywordRequired
// resolves empty, as a keyword the SDK skips does, except that the keyword did go out.
describe("autocompleteByKeyword when the server refuses a keyword the SDK judged qualifying", () => {
  it("resolves empty for “ﬁ”, disclosing the keyword it sent", async () => {
    const { server, client } = setup();
    const result = await client.autocompleteByKeyword(OVERTURE).searchByKeyword("ﬁ");
    expect(server.requests).toHaveLength(1);
    expect(result).toEqual({ places: [], attribution: [], disclosed: { keyword: true, region: null } });
  });

  it("reports the region it sent with the refused keyword", async () => {
    const { client } = setup();
    const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
    const result = await client.autocompleteByKeyword({ ...OVERTURE, region }).searchByKeyword("ﬁ");
    expect(result.disclosed).toEqual({ keyword: true, region: 1 });
  });
});

// #60: rules of section 19 and section 11 that no test killed before.
describe("autocompleteByKeyword cancellation", () => {
  // A fetch whose searchPlaces requests wait for their signal, so a call stays in flight until something aborts it.
  function hanging() {
    const started: string[] = [];
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      started.push(new Request(input).url);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    }) as typeof globalThis.fetch;
    return { fetch, started };
  }

  it("rejects with the caller's own reason, without a request, when the caller's signal is already aborted", async () => {
    const { server, client } = setup();
    const reason = new Error("caller gave up");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(client.autocompleteByKeyword(OVERTURE).searchByKeyword("Zan", { signal: controller.signal })).rejects.toBe(reason);
    expect(server.requests).toHaveLength(0);
  });

  it("resolves empty, without a request, for a keyword that cannot qualify even when the caller's signal is already aborted", async () => {
    const { server, client } = setup();
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    await expect(client.autocompleteByKeyword(OVERTURE).searchByKeyword("a", { signal: controller.signal })).resolves.toEqual(nothing);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects with the caller's own reason when the caller aborts mid-flight", async () => {
    const { fetch, started } = hanging();
    const reason = new Error("caller gave up");
    const controller = new AbortController();
    const call = new AtgeoClient({ fetch }).autocompleteByKeyword(OVERTURE).searchByKeyword("Zan", { signal: controller.signal });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    controller.abort(reason);
    await expect(call).rejects.toBe(reason);
  });

  it("removes its listener from the caller's signal once the call settles", async () => {
    const { client } = setup();
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await client.autocompleteByKeyword(OVERTURE).searchByKeyword("Zan", { signal: controller.signal });
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0][1]);
  });

  it("does not supersede a call on another autocompleter of the same client", async () => {
    const { server } = setup();
    let calls = 0;
    // The first request waits for its signal; the rest go to the fake.
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      ++calls > 1
        ? server.fetch(input, init)
        : new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
            setTimeout(() => resolve(server.fetch(input, init)), 20);
          })) as typeof globalThis.fetch;
    const client = new AtgeoClient({ fetch });
    const first = client.autocompleteByKeyword(OVERTURE).searchByKeyword("Za");
    await client.autocompleteByKeyword(OVERTURE).searchByKeyword("Zan");
    await expect(first).resolves.toMatchObject({ disclosed: { keyword: true } });
  });

  it("names the keyword in the error for a keyword that is not a string", async () => {
    const { client } = setup();
    await expect(client.autocompleteByKeyword(OVERTURE).searchByKeyword(5 as never)).rejects.toThrow(/string keyword/);
  });
});
