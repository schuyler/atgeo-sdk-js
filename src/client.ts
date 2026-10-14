import { TileCache, TtlCache, type TileRecord } from "./cache.js";
import { dedupe, inRegion, locate } from "./merge.js";
import { normalize } from "./normalize.js";
import { rank } from "./rank.js";
import { queryBboxes, validateRegion } from "./region.js";
import { Transport, mapLimit } from "./transport.js";
import type {
  ClientOptions,
  PlaceRecord,
  PlaceValue,
  SearchOptions,
  SearchResult,
  ServiceDescription,
  Tileset,
} from "./types.js";

const DEFAULT_DATASET = "overturemaps.org";
const DEFAULT_COLLECTION = "place";
const MAX_TILES_IN_FLIGHT = 8;

export class AtgeoClient {
  private readonly transport: Transport;
  private readonly tiles: TileCache;
  private readonly tileLists = new TtlCache<{ tiles: string[]; overview: boolean }>(3600_000);
  private readonly service = new TtlCache<ServiceDescription>(3600_000);

  constructor(options: ClientOptions = {}) {
    this.transport = new Transport(options.server ?? "https://places.atgeo.org", options.fetch ?? ((...a) => fetch(...a)));
    this.tiles = new TileCache(options.cacheBudgetBytes ?? 50 * 1024 * 1024);
  }

  searchPlaces(options: SearchOptions): Promise<SearchResult> {
    validateRegion(options.region);
    const sort = options.sort ?? "fused";
    const query = normalize(options.text ?? "");
    if (sort === "similarity" && !query) throw new TypeError("sort 'similarity' requires text");
    return this.search(options, query, sort);
  }

  private async search(options: SearchOptions, query: string, sort: NonNullable<SearchOptions["sort"]>): Promise<SearchResult> {
    const { region, signal } = options;
    const dataset = options.dataset ?? DEFAULT_DATASET;
    const collection = options.collection ?? (options.dataset === undefined ? DEFAULT_COLLECTION : undefined);

    const tileLists = await Promise.all(
      queryBboxes(region).map(async (bbox) => {
        const key = `${dataset}|${collection ?? ""}|${bbox}`;
        let list = this.tileLists.get(key);
        if (!list) {
          const params: Record<string, string> = collection === undefined ? { dataset, bbox } : { dataset, collection, bbox };
          const response = await this.transport.xrpc<{ tiles: string[]; overview?: boolean }>("org.atgeo.getTiles", params, signal);
          list = { tiles: response.tiles, overview: response.overview ?? false };
          this.tileLists.set(key, list);
        }
        return list;
      }),
    );
    const urls = [...new Set(tileLists.flatMap((l) => l.tiles))].sort();
    const overview = tileLists.some((l) => l.overview);

    const loaded = new Map<string, TileRecord[]>();
    let failed = 0;
    await mapLimit(urls, MAX_TILES_IN_FLIGHT, async (url) => {
      const cached = this.tiles.get(url);
      if (cached) {
        loaded.set(url, cached.records);
        return;
      }
      try {
        const text = await this.transport.get(url, signal);
        const payload = JSON.parse(text) as { records: TileRecord[] };
        const records = payload.records.map(({ value, uri, importance }) => ({ value, uri, importance }));
        this.tiles.set(url, { records, size: text.length });
        loaded.set(url, records);
      } catch (error) {
        if (signal?.aborted) throw error;
        failed++;
      }
    });

    const prefix = collection === undefined ? undefined : `urn:atgeo:${dataset}:${collection}:`;
    const records = dedupe(urls.flatMap((url) => loaded.get(url) ?? []))
      .filter((r) => prefix === undefined || (typeof r.value.origin === "string" && r.value.origin.startsWith(prefix)))
      .filter((r) => inRegion(locate(r.value), region));
    return {
      places: rank(records, region, query, sort),
      complete: failed === 0,
      overview,
      tiles: { fetched: loaded.size, failed },
    };
  }

  async getPlace(options: { origin: string; signal?: AbortSignal }): Promise<PlaceRecord> {
    const { origin } = options;
    const cached = this.tiles.find(origin);
    if (cached) return { origin, place: cached.value, importance: cached.importance ?? null };
    const { record, importance } = await this.transport.xrpc<{ record: PlaceValue; importance?: number }>(
      "org.atgeo.getPlace",
      { uri: origin },
      options.signal,
    );
    return { origin, place: record, importance: importance ?? null };
  }

  async describeService(options: { signal?: AbortSignal } = {}): Promise<ServiceDescription> {
    let service = this.service.get("");
    if (!service) {
      service = await this.transport.xrpc<ServiceDescription>("org.atgeo.describeService", {}, options.signal);
      this.service.set("", service);
    }
    return service;
  }

  describeTileset(slug: string, options: { signal?: AbortSignal } = {}): Promise<Tileset> {
    return this.transport.xrpc<Tileset>("org.atgeo.describeTileset", { slug }, options.signal);
  }
}
