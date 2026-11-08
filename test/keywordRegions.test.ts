import { describe, expect, it } from "vitest";
import fixture from "../fixtures/keyword-regions.json" with { type: "json" };
import { AtgeoClient } from "../src/index.js";
import { OVERTURE, fakeServer, overture } from "./helpers/fakeServer.js";

// fixtures/keyword-regions.json: the whole-degree bbox a keyword search sends for each input box. The
// fake server refuses a bbox with decimals and one the real server would call invalid, so a case passes
// only if the server accepts what was sent, whatever the fixture's arithmetic says.

interface Case {
  name: string;
  bbox: [number, number, number, number];
  sent: string;
}

const cases = fixture as unknown as Case[];

async function run(bbox: Case["bbox"]) {
  const server = fakeServer({ tilesets: [overture([])] });
  await new AtgeoClient({ fetch: server.fetch }).searchByKeyword({ ...OVERTURE, keyword: "Zanzibar", region: { bbox } });
  return server.requests;
}

describe("keyword regions", () => {
  it.each(cases)("$name", async ({ bbox, sent }) => {
    const requests = await run(bbox);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].url);
    expect(url.searchParams.get("bbox")).toBe(sent);
    expect(sent).toMatch(/^(0|-?[1-9]\d*)(,(0|-?[1-9]\d*)){3}$/);
  });

  it("keeps every digit of a precise box off the wire", async () => {
    const requests = await run([-122.4194155, 37.7749295, -122.4094155, 37.7849295]);
    expect(new URL(requests[0].url).searchParams.get("bbox")).toBe("-123,37,-122,38");
    for (const r of requests) {
      for (const needle of ["7749295", "4194155", "4094155", "7849295"]) expect(r.url).not.toContain(needle);
    }
  });
});
