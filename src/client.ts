import { TileCache, TtlCache, type TileRecord } from "./cache.js";
import { dedupe, inRegion, locate } from "./merge.js";
import { normalize } from "./normalize.js";
import { rank } from "./rank.js";
import { queryBboxes, validateRegion } from "./region.js";
import { AtgeoError, Transport, mapLimit } from "./transport.js";
import type {
  ClientOptions,
  CollectionInfo,
  PlaceRecord,
  PlaceValue,
  SearchOptions,
  SearchResult,
  ServiceDescription,
} from "./types.js";

const DEFAULT_COLLECTION = "org.atgeo.places.overture.place";
const MAX_TILES_IN_FLIGHT = 8;

export class AtgeoClient {
  private readonly transport: Transport;
  private readonly tiles: TileCache;
  private readonly coverage = new TtlCache<string[]>(3600_000);
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
    const collection = options.collection ?? DEFAULT_COLLECTION;

    const coverages = await Promise.all(
      queryBboxes(region).map(async (bbox) => {
        const key = `${collection}|${bbox}`;
        let urls = this.coverage.get(key);
        if (!urls) {
          urls = (await this.transport.xrpc<{ tiles: string[] }>("org.atgeo.getCoverage", { collection, bbox }, signal)).tiles;
          this.coverage.set(key, urls);
        }
        return urls;
      }),
    );
    const urls = [...new Set(coverages.flat())];

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
        const payload = JSON.parse(text) as { collection: string; records: TileRecord[] };
        const records = payload.records.map(({ uri, value }) => ({ uri, value }));
        this.tiles.set(url, { collection: payload.collection, records, size: text.length });
        loaded.set(url, records);
      } catch (error) {
        if (signal?.aborted) throw error;
        failed++;
      }
    });

    const records = dedupe(urls.flatMap((url) => loaded.get(url) ?? [])).filter((r) => inRegion(locate(r.value), region));
    return {
      places: rank(records, region, query, sort),
      complete: failed === 0,
      tiles: { fetched: loaded.size, failed },
    };
  }

  async getPlace(options: { collection: string; rkey: string; signal?: AbortSignal }): Promise<PlaceRecord> {
    const cached = this.tiles.find(options.collection, options.rkey);
    if (cached) return { uri: cached.uri, place: cached.value };
    const { did } = await this.describeService({ signal: options.signal });
    const record = await this.transport.xrpc<{ uri: string; value: PlaceValue; importance?: number }>(
      "com.atproto.repo.getRecord",
      { repo: did, collection: options.collection, rkey: options.rkey },
      options.signal,
    );
    const place = record.importance === undefined ? record.value : { ...record.value, importance: record.importance };
    return { uri: record.uri, place };
  }

  async describeService(options: { signal?: AbortSignal } = {}): Promise<ServiceDescription> {
    let service = this.service.get("");
    if (!service) {
      service = await this.transport.xrpc<ServiceDescription>("org.atgeo.describeService", {}, options.signal);
      this.service.set("", service);
    }
    return service;
  }

  async getCollectionInfo(collection: string, options: { signal?: AbortSignal } = {}): Promise<CollectionInfo | null> {
    const entry = (await this.describeService(options)).collections.find((c) => c.collection === collection);
    if (!entry) throw new AtgeoError("CollectionNotFound", `Collection ${collection} not found`);
    if (!entry.metadata) return null;
    return JSON.parse(await this.transport.get(entry.metadata, options.signal)) as CollectionInfo;
  }
}
