import type { CollectionInfo, PlaceValue } from "../../src/index.js";

export const DEFAULT_SERVER = "https://places.atgeo.org";
export const PLACES = "org.atgeo.places.overture.place";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeCollection {
  tiles: { url: string; records: PlaceValue[] }[];
  // Tile URLs returned for a getCoverage bbox string; default: every tile.
  // Returning an error object answers 400 with that body; { tiles, summary: true }
  // marks the answer as a summary-band fallback.
  coverage?: (bbox: string) => string[] | { tiles: string[]; summary?: boolean } | { error: string; message: string };
  // org.atgeo.collection record; absent means describeService lists no metadata link.
  metadata?: CollectionInfo;
}

export interface FakeServerOptions {
  server?: string;
  collections?: Record<string, FakeCollection>;
  failTiles?: string[];
}

export interface FakeServer {
  fetch: typeof fetch;
  requests: CapturedRequest[];
  // After this, every request rejects as a network failure.
  goOffline(): void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const xrpcError = (error: string, message: string, status = 400) => json({ error, message }, status);

export function point(lat: number, lon: number) {
  return {
    $type: "community.lexicon.location.geo",
    latitude: lat.toFixed(6),
    longitude: lon.toFixed(6),
  };
}

export function bboxLocation(north: number, south: number, east: number, west: number) {
  return {
    $type: "community.lexicon.location.bbox",
    north: north.toFixed(6),
    south: south.toFixed(6),
    east: east.toFixed(6),
    west: west.toFixed(6),
  };
}

export function place(
  rkey: string,
  name: string,
  locations: unknown[],
  extra: { importance?: number; variants?: { name: string }[] } & PlaceValue = {},
): PlaceValue {
  return { rkey, name, locations, ...extra };
}

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const server = options.server ?? DEFAULT_SERVER;
  const collections = options.collections ?? {};
  const failTiles = new Set(options.failTiles ?? []);
  const requests: CapturedRequest[] = [];
  let offline = false;

  // garganorn declares did:web:{repo} and validates getRecord's repo as an at-identifier.
  const did = `did:web:${new URL(server).hostname}`;
  const recordUri = (collection: string, rkey: string) => `${server}/${collection}/${rkey}`;
  const metadataUri = (collection: string) => recordUri("org.atgeo.collection", collection);

  const handle = (url: URL): Response => {
    const xrpc = url.href.startsWith(`${server}/xrpc/`) ? url.pathname.split("/").pop() : null;

    if (xrpc === "org.atgeo.describeService") {
      return json({
        did,
        collections: Object.entries(collections).map(([collection, c]) =>
          c.metadata ? { collection, metadata: metadataUri(collection) } : { collection },
        ),
      });
    }

    if (xrpc === "org.atgeo.getCoverage") {
      const collection = url.searchParams.get("collection") ?? "";
      const c = collections[collection];
      if (!c) return xrpcError("CollectionNotFound", `Collection ${collection} not found`);
      const tiles = c.coverage ? c.coverage(url.searchParams.get("bbox") ?? "") : c.tiles.map((t) => t.url);
      if (Array.isArray(tiles)) return json({ tiles });
      if ("error" in tiles) return xrpcError(tiles.error, tiles.message);
      return json(tiles.summary ? { tiles: tiles.tiles, summary: true } : { tiles: tiles.tiles });
    }

    if (xrpc === "com.atproto.repo.getRecord") {
      if (url.searchParams.get("repo") !== did) return xrpcError("InvalidRequest", "repo is invalid for format at-identifier");
      const collection = url.searchParams.get("collection") ?? "";
      const rkey = url.searchParams.get("rkey") ?? "";
      const c = collections[collection];
      if (!c) return xrpcError("CollectionNotFound", `Collection ${collection} not found`);
      const value = c.tiles.flatMap((t) => t.records).find((r) => r.rkey === rkey);
      if (!value) return xrpcError("RecordNotFound", `Record ${rkey} not found`);
      // getRecord hoists importance out of the value into the envelope.
      const { importance, ...rest } = value;
      return json({
        uri: recordUri(collection, rkey),
        ...(importance === undefined ? {} : { importance }),
        value: rest,
      });
    }

    for (const [collection, c] of Object.entries(collections)) {
      if (c.metadata && url.href === metadataUri(collection)) return json(c.metadata);
      const tile = c.tiles.find((t) => t.url === url.href);
      if (tile) {
        if (failTiles.has(tile.url)) return new Response("upstream error", { status: 500 });
        return json({
          collection,
          source: "https://example.org/source",
          license: "https://example.org/license",
          generated_at: "2026-01-01T00:00:00Z",
          records: tile.records.map((value) => ({
            uri: recordUri(collection, String(value.rkey)),
            cid: null,
            value,
          })),
        });
      }
    }

    if (url.href.startsWith(`${server}/org.atgeo.collection/`)) {
      return xrpcError("RecordNotFound", "Record not found", 404);
    }
    return new Response("Not found", { status: 404 });
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = request.body ? await request.text() : null;
    requests.push({ url: request.url, method: request.method, headers, body });
    if (offline) throw new TypeError("network disabled");
    return handle(new URL(request.url));
  };

  return {
    fetch: fetchImpl as typeof fetch,
    requests,
    goOffline() {
      offline = true;
    },
  };
}
