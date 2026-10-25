import { getEventListeners } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AtgeoClient, BodyTooLargeError, type TileFailure } from "../src/index.js";
import { OVERTURE, DEFAULT_SERVER, place, point, record } from "./helpers/fakeServer.js";

// The parts of the limits that need Node: a real server (undici's fetch, real gzip) and listener counts.
// The rest, which needs only fetch, is in limits.test.ts and also runs in the browser.
const region = { bbox: [-122.42, 37.77, -122.41, 37.78] as [number, number, number, number] };
const encoder = new TextEncoder();

function tileOfSize(bytes: number, name = "A"): Uint8Array<ArrayBuffer> {
  const doc = encoder.encode(JSON.stringify({ records: [record(place("a", name, [point(37.772, -122.412)]))] }));
  const out = new Uint8Array(new ArrayBuffer(bytes)).fill(0x20);
  out.set(doc);
  return out;
}

describe("listeners", () => {
  const TILE = "https://tiles.example/a.json";
  const tileFetch = (tile: (init: RequestInit | undefined) => Response | Promise<Response>) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input).url.startsWith(`${DEFAULT_SERVER}/xrpc/org.atgeo.getTiles`)) return new Response(JSON.stringify({ tiles: [TILE] }));
      return tile(init);
    }) as typeof fetch;
  const stalledFetch = (init: RequestInit | undefined) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const search = (client: AtgeoClient, signal?: AbortSignal) => client.searchPlaces({ ...OVERTURE, region, signal });

  it("leaves no listener on the caller's signal once a request is done", async () => {
    const controller = new AbortController();
    const client = new AtgeoClient({ fetch: tileFetch(() => new Response(tileOfSize(600))) });
    await search(client, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const failing = new AtgeoClient({ fetch: tileFetch(stalledFetch), requestTimeoutMs: 10 });
    await search(failing, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("over real HTTP", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const MiB = 1024 * 1024;
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/xrpc/org.atgeo.getTiles") {
        // One region (around 10,10) is answered with the tiles that stall; any other with the rest.
        const stalling = (new URL(req.url ?? "/", "http://x").searchParams.get("bbox") ?? "").startsWith("10");
        const names = stalling ? ["stall-headers", "stall-body"] : ["bomb", "ok"];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ tiles: names.map((t) => `${base}/tile/${t}`) }));
      } else if (path === "/tile/bomb") {
        // 8 MiB of spaces: a few KiB on the wire.
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.alloc(8 * MiB, 0x20)));
      } else if (path === "/tile/ok") {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.from(tileOfSize(2000))));
      } else if (path === "/tile/stall-body") {
        res.writeHead(200);
        res.write(`{"records":[`);
      }
      // stall-headers: never answered.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const stallRegion = { bbox: [10, 10, 10.01, 10.01] as [number, number, number, number] };

  it("caps decoded bytes, not wire bytes", async () => {
    // No short timeout here: gzip, an 8 MiB inflate and a cold connection can be slow on a busy machine.
    const client = new AtgeoClient({ server: base, maxBodyBytes: 1024 * 1024, requestTimeoutMs: 20_000 });
    const result = await client.searchPlaces({ ...OVERTURE, region });
    expect(result.tileFailures).toEqual([{ url: `${base}/tile/bomb`, kind: "transport", error: expect.any(BodyTooLargeError) }]);
    expect(result.tiles).toEqual({ fetched: 1, failed: 1 });
    expect(result.places).toHaveLength(1);
  });

  it("times out stalls in the headers and in the body", async () => {
    const client = new AtgeoClient({ server: base, requestTimeoutMs: 300 });
    const result = await client.searchPlaces({ ...OVERTURE, region: stallRegion });
    const byUrl: Record<string, TileFailure> = Object.fromEntries(result.tileFailures.map((f) => [f.url.split("/").pop(), f]));
    expect(Object.keys(byUrl).sort()).toEqual(["stall-body", "stall-headers"]);
    for (const failure of Object.values(byUrl)) {
      expect(failure.kind).toBe("transport");
      expect(failure.error).toMatchObject({ name: "TimeoutError" });
    }
    expect(result.tiles).toEqual({ fetched: 0, failed: 2 });
  });

  it("reports a caller's abort during a stalled body as the caller's abort", async () => {
    const controller = new AbortController();
    const client = new AtgeoClient({ server: base, requestTimeoutMs: 60_000 });
    const p = client.searchPlaces({ ...OVERTURE, region: stallRegion, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
