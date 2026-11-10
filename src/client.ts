import { TileCache, TtlCache, type TileRecord } from "./cache.js";
import { collectionOf, collectionPrefix, copyAttribution, inCollection, mergeAttribution } from "./attribution.js";
import { dedupe, describe, inRegion, locate } from "./merge.js";
import { normalize } from "./normalize.js";
import { matchTier, qualifies, rank } from "./rank.js";
import { circleBox, keywordBbox, queryBboxes, validateRegion } from "./region.js";
import { AtgeoError, Transport, checkStatus, mapLimit, type HttpResponse } from "./transport.js";
import { isObject, readPlace, readSearchPlaces, readServiceDescription, readTileList, readTilePayload, readTileset } from "./wire.js";
import type {
  Attribution,
  ClientOptions,
  PlaceRecord,
  FallbackSearchOptions,
  FallbackSearchResult,
  KeywordAutocomplete,
  KeywordAutocompleteOptions,
  KeywordHit,
  KeywordSearchOptions,
  KeywordSearchResult,
  NearbySearchOptions,
  NearbySearchResult,
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

  searchNearby(options: NearbySearchOptions): Promise<NearbySearchResult> {
    // First, before the region and sort checks: a missing dataset is the caller's argument error (contract section 4.1).
    requireDataset(options, "searchNearby");
    validateRegion(options.region);
    const sort = options.sort ?? "fused";
    const query = normalize(options.text ?? "");
    if (sort === "similarity" && !query) throw new TypeError("sort 'similarity' requires text");
    return this.search(options, query, sort);
  }

  searchByKeyword(options: KeywordSearchOptions): Promise<KeywordSearchResult> {
    requireDataset(options, "searchByKeyword");
    if (typeof options.keyword !== "string") throw new TypeError("searchByKeyword requires a string keyword");
    validateKeywordRegion(options.region);
    return this.keywordSearch(options);
  }

  private async keywordSearch(options: KeywordSearchOptions): Promise<KeywordSearchResult> {
    const { dataset, collection, keyword, region } = options;
    const params: Record<string, string> = { dataset, ...(collection !== undefined && { collection }), q: keyword };
    if (region) params.bbox = keywordBbox(region.bbox);
    const { places } = readSearchPlaces(await this.transport.xrpc("org.atgeo.searchPlaces", params, options.signal));
    return {
      places: places.map(
        (p): KeywordHit => ({
          via: "keyword",
          origin: p.origin,
          collection: collectionOf(p.value, p.attribution),
          place: p.value,
          importance: p.importance ?? null,
          ...describe(p.value, locate(p.value)),
        }),
      ),
      attribution: mergeAttribution(places.map((p) => p.attribution)),
      disclosed: { keyword: true, region: region ? 1 : null },
    };
  }

  searchNearbyThenByKeyword(options: FallbackSearchOptions): Promise<FallbackSearchResult> {
    requireDataset(options, "searchNearbyThenByKeyword");
    if (typeof options.keyword !== "string") throw new TypeError("searchNearbyThenByKeyword requires a string keyword");
    if (options.keywordRegion !== "none" && options.keywordRegion !== "degree") {
      throw new TypeError("keywordRegion must be 'none' or 'degree'");
    }
    return this.fallbackSearch(options, this.searchNearby({ ...options, expand: options.expand ?? true, text: options.keyword }));
  }

  private async fallbackSearch(options: FallbackSearchOptions, pending: Promise<NearbySearchResult>): Promise<FallbackSearchResult> {
    const { dataset, collection, region, keyword, keywordRegion, signal } = options;
    const nearby = await pending;
    const query = normalize(keyword);
    if (nearby.places.some((hit) => matchTier(query, hit.place) === 1) || !qualifies(keyword)) return nearby;
    let found: KeywordSearchResult;
    try {
      found = await this.searchByKeyword({
        dataset,
        ...(collection !== undefined && { collection }),
        keyword,
        ...(keywordRegion === "degree" && { region: { bbox: "bbox" in region ? region.bbox : circleBox(region.lat, region.lon, region.radius) } }),
        signal,
      });
    } catch (error) {
      // The server refused a keyword the qualifying check let through (contract section 18, step 8): keep the
      // nearby result, which is what skipping the request would have returned, but report the keyword as sent.
      if (!isKeywordRequired(error)) throw error;
      return { ...nearby, disclosed: { keyword: true, region: nearby.disclosed.region ?? (keywordRegion === "degree" ? 1 : null) } };
    }
    const origins = new Set(found.places.map((hit) => hit.origin));
    return {
      ...nearby,
      places: [...found.places, ...nearby.places.filter((hit) => hit.origin === null || !origins.has(hit.origin))],
      attribution: mergeAttribution([nearby.attribution, found.attribution]),
      disclosed: { keyword: true, region: nearby.disclosed.region ?? found.disclosed.region },
    };
  }

  autocompleteByKeyword(options: KeywordAutocompleteOptions): KeywordAutocomplete {
    requireDataset(options, "autocompleteByKeyword");
    validateKeywordRegion(options.region);
    const { dataset, collection, region } = options;
    let previous: AbortController | undefined;
    return {
      searchByKeyword: async (keyword, { signal } = {}) => {
        previous?.abort();
        if (typeof keyword !== "string") throw new TypeError("searchByKeyword requires a string keyword");
        if (!qualifies(keyword)) return { places: [], attribution: [], disclosed: { keyword: false, region: null } };
        // Combined by hand: AbortSignal.any is missing on Node 20.0 to 20.2.
        const controller = (previous = new AbortController());
        const onAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        try {
          return await this.searchByKeyword({
            dataset,
            ...(collection !== undefined && { collection }),
            keyword,
            ...(region && { region }),
            signal: controller.signal,
          });
        } catch (error) {
          // As for a keyword the qualifying check skips, except that this one went out (contract section 19).
          if (!isKeywordRequired(error)) throw error;
          return { places: [], attribution: [], disclosed: { keyword: true, region: region ? 1 : null } };
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      },
    };
  }

  private async search(options: NearbySearchOptions, query: string, sort: NonNullable<NearbySearchOptions["sort"]>): Promise<NearbySearchResult> {
    const { region, signal, dataset, collection } = options;

    // Whether anything went to the server that tells it the client is interested in the area.
    let sent = false;
    const tileLists = await Promise.all(
      queryBboxes(region).map(async (bbox) => {
        const key = `${dataset}|${collection ?? ""}|${bbox}`;
        let list = this.tileLists.get(key);
        if (!list) {
          const params: Record<string, string> = collection === undefined ? { dataset, bbox } : { dataset, collection, bbox };
          sent = true;
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
      if (!("kind" in outcome && outcome.kind === "refused")) sent = true;
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
    const candidates = dedupe(
      used.flatMap((url) => {
        const tile = loaded.get(url)!;
        return tile.records.map((record) => ({ record, attribution: tile.attribution }));
      }),
    ).filter(({ record }) => prefix === undefined || inCollection(record.value, prefix));
    let places = rank(
      candidates.filter(({ record }) => inRegion(locate(record.value), region)),
      region,
      query,
      sort,
      overview,
    );
    // The tiles cover more than the region, and they are already in hand. With no word match in the region, look
    // at everything they hold that has a location; if that has one, it is the answer.
    let expanded = false;
    if (options.expand && query !== "" && !places.some((hit) => matchTier(query, hit.place) === 1)) {
      const wider = rank(
        candidates.filter(({ record }) => {
          const { point, bbox } = locate(record.value);
          return point !== null || bbox !== null;
        }),
        region,
        query,
        sort,
        overview,
      );
      if (wider.some((hit) => matchTier(query, hit.place) === 1)) {
        places = wider;
        expanded = true;
      }
    }
    return {
      places,
      expanded,
      complete: failed === 0,
      overview,
      tiles: { fetched: loaded.size, failed },
      tileFailures,
      attribution,
      disclosed: { keyword: false, region: sent ? 0.01 : null },
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
      return {
        origin,
        place: record.value,
        importance: record.importance ?? null,
        attribution: copyAttribution(attribution ?? []),
        ...describe(record.value, locate(record.value)),
      };
    }
    const { value, importance, attribution } = readPlace(
      await this.transport.xrpc("org.atgeo.getPlace", { uri: origin }, options.signal),
    );
    return { origin, place: value, importance: importance ?? null, attribution, ...describe(value, locate(value)) };
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

function requireDataset(options: { dataset?: unknown }, method: string): void {
  if (typeof options.dataset !== "string") throw new TypeError(`${method} requires a dataset`);
}

function validateKeywordRegion(region: unknown): void {
  if (region === undefined || region === null) return;
  if (!isObject(region) || !("bbox" in region)) throw new TypeError("a keyword search region must be a bbox, not a circle");
  validateRegion(region as { bbox: [number, number, number, number] });
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

// The server's refusal of a keyword with no word long enough, which the qualifying predicate (contract section 17)
// can fail to foresee for compatibility characters such as "ﬁ".
function isKeywordRequired(error: unknown): boolean {
  return error instanceof AtgeoError && error.code === "KeywordRequired";
}
