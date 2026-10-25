import { Lexicons, type LexiconDoc } from "@atproto/lexicon";
import type { PlaceValue } from "../../src/index.js";
import address from "../lexicon/address.json" with { type: "json" };
import bbox from "../lexicon/bbox.json" with { type: "json" };
import defs from "../lexicon/defs.json" with { type: "json" };
import describeService from "../lexicon/describeService.json" with { type: "json" };
import describeTileset from "../lexicon/describeTileset.json" with { type: "json" };
import geo from "../lexicon/geo.json" with { type: "json" };
import getPlace from "../lexicon/getPlace.json" with { type: "json" };
import getTiles from "../lexicon/getTiles.json" with { type: "json" };
import placeLexicon from "../lexicon/place.json" with { type: "json" };
import tilePayload from "../lexicon/tilePayload.json" with { type: "json" };

const lexicons = new Lexicons([
  address,
  bbox,
  defs,
  describeService,
  describeTileset,
  geo,
  getPlace,
  getTiles,
  placeLexicon,
  tilePayload,
] as unknown as LexiconDoc[]);

export const DEFAULT_SERVER = "https://places.atgeo.org";
const PUBLISHED_AT = "2026-01-01T00:00:00Z";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface TileRecord {
  value: PlaceValue;
  uri?: string;
  importance?: number;
}

type CollectionInfo = { dataset: string; collection: string } & Record<string, unknown>;

export interface FakeTileset {
  slug: string;
  collections: CollectionInfo[];
  references?: Record<string, unknown>[];
  overview?: { records: number };
  tiles: { url: string; records: TileRecord[] }[];
}

export type TilesFor = (bbox: string) => string[] | { tiles: string[]; overview?: boolean } | { error: string; message: string };

export interface FakeServerOptions {
  server?: string;
  // Default: one tileset, "overture-place", carrying overturemaps.org / place.
  tilesets?: FakeTileset[];
  // Replaces the whole getTiles answer after dataset and collection selection has passed.
  tilesFor?: TilesFor;
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

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const placeOrigin = (id: string) => `urn:atgeo:overturemaps.org:place:${id}`;

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

// `extra` may override `origin`, or set it to undefined to make a value with no origin.
export function place(id: string, name: string, locations: unknown[], extra: PlaceValue = {}): PlaceValue {
  return { $type: "org.atgeo.place", origin: placeOrigin(id), name, locations, ...extra };
}

export function record(value: PlaceValue, importance?: number, uri?: string): TileRecord {
  return { value, ...(importance === undefined ? {} : { importance }), ...(uri === undefined ? {} : { uri }) };
}

// The dataset and collection a search names; searchPlaces has no defaults (contract section 4.1).
export const OVERTURE = { dataset: "overturemaps.org", collection: "place" } as const;

export function overture(tiles: FakeTileset["tiles"]): FakeTileset {
  return { slug: "overture-place", collections: [{ dataset: "overturemaps.org", collection: "place" }], tiles };
}

const attributionOf = ({ dataset, collection, release, source, licenses, attribution }: CollectionInfo) =>
  wire({ dataset, collection, release, source, licenses, attribution });

// The attribution every tile of the tileset carries, and getPlace answers with: its collections, then its references.
const attributionList = (tileset: FakeTileset) => [
  ...tileset.collections.map(attributionOf),
  ...wire(tileset.references ?? []),
];

function tileBody(tileset: FakeTileset, records: TileRecord[]) {
  return wire({ publishedAt: PUBLISHED_AT, attribution: attributionList(tileset), records });
}

const descriptorOf = ({ slug, collections, references, overview }: FakeTileset) =>
  wire({ slug, collections, ...(references ? { references } : {}), ...(overview ? { overview } : {}) });

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const server = options.server ?? DEFAULT_SERVER;
  const tilesets = options.tilesets ?? [overture([])];
  const failTiles = new Set(options.failTiles ?? []);
  const requests: CapturedRequest[] = [];
  let offline = false;

  for (const tileset of tilesets) {
    lexicons.assertValidXrpcOutput("org.atgeo.describeTileset", descriptorOf(tileset));
    for (const tile of tileset.tiles) {
      const result = lexicons.validate("org.atgeo.tilePayload", tileBody(tileset, tile.records));
      if (!result.success) throw result.error;
      for (const { value } of tile.records) lexicons.assertValidRecord("org.atgeo.place", wire(value));
    }
  }

  const did = `did:web:${new URL(server).hostname}`;

  const answer = (nsid: string, body: unknown): Response => {
    lexicons.assertValidXrpcOutput(nsid, body);
    return json(body);
  };

  const getTilesAnswer = (params: Record<string, string>): Response => {
    const { dataset, collection, bbox } = params;
    const withDataset = tilesets.filter((t) => t.collections.some((c) => c.dataset === dataset));
    if (withDataset.length === 0) return xrpcError("DatasetNotFound", `Dataset ${dataset} not found`);
    const selected = withDataset.filter((t) =>
      t.collections.some((c) => c.dataset === dataset && (collection === undefined || c.collection === collection)),
    );
    if (selected.length === 0) return xrpcError("CollectionNotFound", `Collection ${collection} not found`);
    const urls = selected.flatMap((t) => t.tiles.map((tile) => tile.url)).sort();
    const tiles = options.tilesFor ? options.tilesFor(bbox) : urls;
    if (Array.isArray(tiles)) return answer("org.atgeo.getTiles", { tiles });
    if ("error" in tiles) return xrpcError(tiles.error, tiles.message);
    return answer("org.atgeo.getTiles", tiles);
  };

  const getPlaceAnswer = (origin: string): Response => {
    const [, , dataset, collection, ...rest] = origin.split(":");
    const notFound = () => xrpcError("PlaceNotFound", `Place ${origin} not found`);
    for (const tileset of tilesets) {
      if (!tileset.collections.some((c) => c.dataset === dataset && c.collection === collection)) continue;
      for (const tile of tileset.tiles) {
        const found = tile.records.find((r) => r.value.origin === origin);
        if (found) {
          return answer("org.atgeo.getPlace", {
            uri: origin,
            url: `${server}/${dataset}/${collection}/${rest.join(":")}`,
            ...(found.importance === undefined ? {} : { importance: found.importance }),
            value: found.value,
            attribution: attributionList(tileset),
          });
        }
      }
    }
    return notFound();
  };

  const handle = (url: URL): Response => {
    if (url.href.startsWith(`${server}/xrpc/`)) {
      const nsid = url.pathname.split("/").pop() as string;
      const handlers: Record<string, (params: Record<string, string>) => Response> = {
        "org.atgeo.getTiles": getTilesAnswer,
        "org.atgeo.getPlace": (params) => getPlaceAnswer(params.uri),
        "org.atgeo.describeService": () =>
          answer("org.atgeo.describeService", {
            did,
            maxTiles: 50,
            tilesets: tilesets.map((t) => ({
              slug: t.slug,
              collections: t.collections.map(({ dataset, collection }) => ({ dataset, collection })),
            })),
          }),
        "org.atgeo.describeTileset": ({ slug }) => {
          const tileset = tilesets.find((t) => t.slug === slug);
          return tileset ? answer("org.atgeo.describeTileset", descriptorOf(tileset)) : xrpcError("TilesetNotFound", `Tileset ${slug} not found`);
        },
      };
      const handler = handlers[nsid];
      if (!handler) return xrpcError("MethodNotImplemented", `Method ${nsid} not implemented`, 501);
      const params = Object.fromEntries(url.searchParams);
      try {
        lexicons.assertValidXrpcParams(nsid, params);
      } catch (error) {
        return xrpcError("InvalidRequest", (error as Error).message);
      }
      return handler(params);
    }

    for (const tileset of tilesets) {
      const tile = tileset.tiles.find((t) => t.url === url.href);
      if (tile) {
        if (failTiles.has(tile.url)) return new Response("upstream error", { status: 500 });
        return json(tileBody(tileset, tile.records));
      }
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
