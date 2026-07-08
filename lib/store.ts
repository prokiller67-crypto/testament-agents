import { Redis } from "@upstash/redis";

/**
 * Minimal storage interface — exactly the Redis subset TESTAMENT needs.
 * Backed by Upstash Redis in production and an in-memory map in local dev.
 */
export interface Store {
  hgetall(key: string): Promise<Record<string, string> | null>;
  hset(key: string, obj: Record<string, string>): Promise<void>;
  /** Returns 1 if the field was set (didn't exist), 0 if it already existed. */
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hincrby(key: string, field: string, by: number): Promise<number>;
  set(key: string, value: string, opts?: { px?: number }): Promise<void>;
  exists(key: string): Promise<number>;
  del(...keys: string[]): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  zrangebyscore(key: string, min: number, max: number, limit: number): Promise<string[]>;
  lpush(key: string, value: string): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<void>;
}

class UpstashStore implements Store {
  private r: Redis;
  constructor(url: string, token: string) {
    this.r = new Redis({ url, token, automaticDeserialization: false });
  }
  async hgetall(key: string) {
    // With automaticDeserialization:false Upstash returns the raw Redis reply:
    // a flat [field, value, field, value, ...] array. Normalize to an object.
    const res = (await this.r.hgetall<Record<string, string>>(key)) as
      | Record<string, string>
      | string[]
      | null;
    if (!res) return null;
    if (Array.isArray(res)) {
      if (res.length === 0) return null;
      const obj: Record<string, string> = {};
      for (let i = 0; i + 1 < res.length; i += 2) obj[res[i]] = res[i + 1];
      return obj;
    }
    return Object.keys(res).length > 0 ? res : null;
  }
  async hset(key: string, obj: Record<string, string>) {
    await this.r.hset(key, obj);
  }
  async hsetnx(key: string, field: string, value: string) {
    return await this.r.hsetnx(key, field, value);
  }
  async hincrby(key: string, field: string, by: number) {
    return await this.r.hincrby(key, field, by);
  }
  async set(key: string, value: string, opts?: { px?: number }) {
    if (opts?.px) await this.r.set(key, value, { px: opts.px });
    else await this.r.set(key, value);
  }
  async exists(key: string) {
    return await this.r.exists(key);
  }
  async del(...keys: string[]) {
    if (keys.length) await this.r.del(...keys);
  }
  async expire(key: string, seconds: number) {
    await this.r.expire(key, seconds);
  }
  async zadd(key: string, score: number, member: string) {
    await this.r.zadd(key, { score, member });
  }
  async zrem(key: string, member: string) {
    await this.r.zrem(key, member);
  }
  async zrangebyscore(key: string, min: number, max: number, limit: number) {
    const res = await this.r.zrange<string[]>(key, min, max, {
      byScore: true,
      offset: 0,
      count: limit,
    });
    return res ?? [];
  }
  async lpush(key: string, value: string) {
    await this.r.lpush(key, value);
  }
  async ltrim(key: string, start: number, stop: number) {
    await this.r.ltrim(key, start, stop);
  }
  async lrange(key: string, start: number, stop: number) {
    const res = await this.r.lrange<string>(key, start, stop);
    return res ?? [];
  }
  async incr(key: string) {
    return await this.r.incr(key);
  }
  async pexpire(key: string, ms: number) {
    await this.r.pexpire(key, ms);
  }
}

/** Dev-only fallback. Single-process, TTL-aware, NOT for production. */
class MemoryStore implements Store {
  private kv = new Map<string, { v: string; exp: number | null }>();
  private hashes = new Map<string, Map<string, string>>();
  private hashExp = new Map<string, number>();
  private zsets = new Map<string, Map<string, number>>();
  private lists = new Map<string, string[]>();

  private aliveKV(key: string): boolean {
    const e = this.kv.get(key);
    if (!e) return false;
    if (e.exp !== null && Date.now() > e.exp) {
      this.kv.delete(key);
      return false;
    }
    return true;
  }
  private hash(key: string): Map<string, string> {
    const exp = this.hashExp.get(key);
    if (exp !== undefined && Date.now() > exp) {
      this.hashes.delete(key);
      this.hashExp.delete(key);
    }
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }
  async hgetall(key: string) {
    const h = this.hash(key);
    if (h.size === 0) return null;
    return Object.fromEntries(h.entries());
  }
  async hset(key: string, obj: Record<string, string>) {
    const h = this.hash(key);
    for (const [f, v] of Object.entries(obj)) h.set(f, v);
  }
  async hsetnx(key: string, field: string, value: string) {
    const h = this.hash(key);
    if (h.has(field)) return 0;
    h.set(field, value);
    return 1;
  }
  async hincrby(key: string, field: string, by: number) {
    const h = this.hash(key);
    const next = parseInt(h.get(field) ?? "0", 10) + by;
    h.set(field, String(next));
    return next;
  }
  async set(key: string, value: string, opts?: { px?: number }) {
    this.kv.set(key, { v: value, exp: opts?.px ? Date.now() + opts.px : null });
  }
  async exists(key: string) {
    return this.aliveKV(key) ? 1 : 0;
  }
  async del(...keys: string[]) {
    for (const k of keys) {
      this.kv.delete(k);
      this.hashes.delete(k);
      this.zsets.delete(k);
      this.lists.delete(k);
    }
  }
  async expire(key: string, seconds: number) {
    const exp = Date.now() + seconds * 1000;
    if (this.hashes.has(key)) this.hashExp.set(key, exp);
    const e = this.kv.get(key);
    if (e) e.exp = exp;
  }
  async zadd(key: string, score: number, member: string) {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    z.set(member, score);
  }
  async zrem(key: string, member: string) {
    this.zsets.get(key)?.delete(member);
  }
  async zrangebyscore(key: string, min: number, max: number, limit: number) {
    const z = this.zsets.get(key);
    if (!z) return [];
    return [...z.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([m]) => m);
  }
  async lpush(key: string, value: string) {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    l.unshift(value);
  }
  async ltrim(key: string, start: number, stop: number) {
    const l = this.lists.get(key);
    if (l) this.lists.set(key, l.slice(start, stop + 1));
  }
  async lrange(key: string, start: number, stop: number) {
    const l = this.lists.get(key) ?? [];
    return l.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async incr(key: string) {
    const cur = this.aliveKV(key) ? parseInt(this.kv.get(key)!.v, 10) : 0;
    const next = cur + 1;
    const exp = this.aliveKV(key) ? this.kv.get(key)!.exp : null;
    this.kv.set(key, { v: String(next), exp });
    return next;
  }
  async pexpire(key: string, ms: number) {
    const e = this.kv.get(key);
    if (e) e.exp = Date.now() + ms;
  }
}

declare global {
  var __testamentStore: Store | undefined;
}

export function getStore(): Store {
  if (globalThis.__testamentStore) return globalThis.__testamentStore;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  let store: Store;
  if (url && token) {
    store = new UpstashStore(url, token);
  } else {
    if (process.env.NODE_ENV === "production") {
      console.warn("[testament] No Redis configured — falling back to in-memory store (NOT durable).");
    }
    store = new MemoryStore();
  }
  globalThis.__testamentStore = store;
  return store;
}
