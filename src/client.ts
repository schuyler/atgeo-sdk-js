import { TileCache, TtlCache, type TileRecord } from "./cache.js";
import { collectionPrefix, copyAttribution, inCollection, mergeAttribution } from "./attribution.js";
import { dedupe, inRegion, locate } from "./merge.js";
import { normalize } from "./normalize.js";
import { rank } from "./rank.js";
import { queryBboxes, validateRegion } from "./region.js";
import { Transport, checkStatus, mapLimit, type HttpResponse } from "./transport.js";
import { readPlace, readServiceDescription, readTileList, readTilePayload, readTileset } from "./wire.js";
import type {
  Attribution,
  ClientOptions,
  PlaceRecord,
  SearchOptions,
  SearchResult,
  ServiceDescription,
  TileFailure,
  TileFailureKind,
  Tileset,
} from "./types.js";

const MAX_TILES_IN_FLIGHT = 8;

export class AtgeoClient {
  private readonly transport: Transport;
  private readonly tiles: TileCache;
  private readonly tileLists = new TtlCache<{ tiles: string[]; overview: boolean }>(3600_000);
  private readonly service = new TtlCache<ServiceDescription>(3600_000);

  constructor(options: ClientOptions = {}) {
    this.transport = new Transport(options.server ?? "https://places.atgeo.org", options.fetch ?? ((...a) => fetch(...a)), {
      maxBodyBytes: options.maxBodyBytes,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    this.tiles = new TileCache(options.cacheBudgetBytes ?? 50 * 1024 * 1024);
  }

  searchPlaces(options: SearchOptions): Promise<SearchResult> {
    // First, before the region and sort checks: a missing dataset is the caller's argument error (contract section 4.1).
    if (typeof (options as { dataset?: unknown }).dataset !== "string") throw new TypeError("searchPlaces requires a dataset");
    validateRegion(options.region);
    const sort = options.sort ?? "fused";
    const query = normalize(options.text ?? "");
    if (sort === "similarity" && !query) throw new TypeError("sort 'similarity' requires text");
    return this.search(options, query, sort);
  }

  private async search(options: SearchOptions, query: string, sort: NonNullable<SearchOptions["sort"]>): Promise<SearchResult> {
    const { region, signal, dataset, collection } = options;

    const tileLists = await Promise.all(
      queryBboxes(region).map(async (bbox) => {
        const key = `${dataset}|${collection ?? ""}|${bbox}`;
        let list = this.tileLists.get(key);
        if (!list) {
          const params: Record<string, string> = collection === undefined ? { dataset, bbox } : { dataset, collection, bbox };
          // A body with no usable tile list throws before anything is cached.
          list = readTileList(await this.transport.xrpc("org.atgeo.getTiles", params, signal));
          this.tileLists.set(key, list);
        }
        return list;
      }),
    );
    const urls = [...new Set(tileLists.flatMap((l) => l.tiles))].sort();
    const overview = tileLists.some((l) => l.overview);

    const loaded = new Map<string, { records: TileRecord[]; attribution?: Attribution[] }>();
    // One slot per URL, so failures come out in URL order whatever order the fetches finish in.
    const failureSlots: (TileFailure | undefined)[] = new Array(urls.length);
    await mapLimit([...urls.keys()], MAX_TILES_IN_FLIGHT, async (index) => {
      const url = urls[index];
      const cached = this.tiles.get(url);
      if (cached) {
        loaded.set(url, cached);
        return;
      }
      const outcome = await this.fetchTile(url, signal);
      if ("kind" in outcome) {
        failureSlots[index] = outcome;
        return;
      }
      // Outside the guarded steps: an error here is the client's own and fails the search.
      this.tiles.set(url, { records: outcome.records, attribution: outcome.attribution, size: outcome.size });
      loaded.set(url, outcome);
    });
    const tileFailures = failureSlots.filter((f): f is TileFailure => f !== undefined);
    const failed = tileFailures.length;

    // Tiles in URL order, whatever order they arrived in. Only tiles that loaded count.
    const used = urls.filter((url) => loaded.has(url));
    const attribution = mergeAttribution(used.map((url) => loaded.get(url)!.attribution));
    const prefix = collection === undefined ? undefined : collectionPrefix(dataset, collection);
    // dedupe picks a winner before the region filter runs. If copies sharing an
    // origin differ in location (possible only in non-garganorn tilesets) and the
    // winner lies outside the region, the place is dropped though another copy is inside.
    const items = dedupe(
      used.flatMap((url) => {
        const tile = loaded.get(url)!;
        return tile.records.map((record) => ({ record, attribution: tile.attribution }));
      }),
    )
      .filter(({ record }) => prefix === undefined || inCollection(record.value, prefix))
      .filter(({ record }) => inRegion(locate(record.value), region));
    return {
      places: rank(items, region, query, sort),
      complete: failed === 0,
      overview,
      tiles: { fetched: loaded.size, failed },
      tileFailures,
      attribution,
    };
  }

  // Fetches and decodes one tile. Every step here handles input from the server or the app, so an
  // error in any of them fails the tile, classified by the step it arose in, not by its type; the
  // one exception is a cancelled search, which rethrows. Returns the failure rather than throwing it.
  private async fetchTile(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<{ records: TileRecord[]; attribution?: Attribution[]; size: number } | TileFailure> {
    const fail = (kind: TileFailureKind, error: unknown, status?: number): TileFailure => {
      if (signal?.aborted) throw error;
      return status === undefined ? { url, kind, error } : { url, kind, status, error };
    };

    const refusal = refuseUrl(url);
    if (refusal) return fail("refused", refusal);

    let response: HttpResponse;
    try {
      response = await this.transport.fetch(url, signal);
    } catch (error) {
      return fail("transport", error);
    }

    let text: string;
    try {
      text = checkStatus(response);
    } catch (error) {
      return fail("status", error, response.status);
    }

    try {
      return { ...readTilePayload(JSON.parse(text)), size: text.length };
    } catch (error) {
      return fail("decode", error);
    }
  }

  async getPlace(options: { origin: string; signal?: AbortSignal }): Promise<PlaceRecord> {
    const { origin } = options;
    const cached = this.tiles.find(origin);
    if (cached) {
      const { record, attribution } = cached;
      return { origin, place: record.value, importance: record.importance ?? null, attribution: copyAttribution(attribution ?? []) };
    }
    const { value, importance, attribution } = readPlace(
      await this.transport.xrpc("org.atgeo.getPlace", { uri: origin }, options.signal),
    );
    return { origin, place: value, importance: importance ?? null, attribution };
  }

  async describeService(options: { signal?: AbortSignal } = {}): Promise<ServiceDescription> {
    let service = this.service.get("");
    if (!service) {
      // A body that is not an object throws before anything is cached.
      service = readServiceDescription(await this.transport.xrpc("org.atgeo.describeService", {}, options.signal));
      this.service.set("", service);
    }
    return service;
  }

  async describeTileset(slug: string, options: { signal?: AbortSignal } = {}): Promise<Tileset> {
    return readTileset(await this.transport.xrpc("org.atgeo.describeTileset", { slug }, options.signal));
  }
}

// What the Fetch standard's Request refuses before any request: a URL that does not parse as
// absolute, or that carries credentials. Fetch also accepts schemes other than http and https,
// which a tile URL may not use. Checked here so every runtime refuses the same URLs, including a
// browser that would otherwise resolve a relative URL against the page.
function refuseUrl(url: string): TypeError | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new TypeError(`tile URL is not an absolute URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new TypeError(`tile URL is not http or https: ${url}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return new TypeError("tile URL carries credentials");
  }
  return undefined;
}
