import type { PlaceValue } from "./types.js";

export interface TileRecord {
  uri: string;
  value: PlaceValue;
}

interface TileEntry {
  collection: string;
  records: TileRecord[];
  size: number;
}

export class TileCache {
  private readonly tiles = new Map<string, TileEntry>();
  private total = 0;

  constructor(private readonly budget: number) {}

  get(url: string): TileEntry | undefined {
    const entry = this.tiles.get(url);
    if (entry) {
      this.tiles.delete(url);
      this.tiles.set(url, entry);
    }
    return entry;
  }

  set(url: string, entry: TileEntry): void {
    const old = this.tiles.get(url);
    if (old) this.total -= old.size;
    this.tiles.delete(url);
    this.tiles.set(url, entry);
    this.total += entry.size;
    for (const [key, victim] of this.tiles) {
      if (this.total <= this.budget) break;
      this.tiles.delete(key);
      this.total -= victim.size;
    }
  }

  find(collection: string, rkey: string): TileRecord | undefined {
    for (const entry of this.tiles.values()) {
      if (entry.collection !== collection) continue;
      const hit = entry.records.find((r) => r.value.rkey === rkey);
      if (hit) return hit;
    }
    return undefined;
  }
}

export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry && Date.now() < entry.expires ? entry.value : undefined;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}
