import { getStore, type Store } from "./store";
import { LIMITS, nowISO } from "./api";

export const willKey = (id: string) => `will:${id}`;
export const hbKey = (id: string) => `hb:${id}`;
export const bequestKey = (code: string) => `bequest:${code}`;
export const DEADLINES = "deadlines";
export const OBITUARIES = "obituaries";
export const STATS = "stats";

const RETENTION_SECONDS = LIMITS.retention_days * 86400;

export interface BequestRef {
  bequest_id: string;
  label: string;
  release: "claim_code" | "public";
  claim_code: string;
}

export interface WillRecord {
  will_id: string;
  handle: string;
  epitaph: string;
  webhook_url: string;
  token: string;
  ttl_s: number;
  created_at_ms: number;
  deadline_ms: number;
  status: "alive" | "dead" | "revoked";
  died_at_ms: number;
  bequests: BequestRef[];
}

export function parseWill(id: string, h: Record<string, string>): WillRecord {
  return {
    will_id: id,
    handle: h.handle ?? "",
    epitaph: h.epitaph ?? "",
    webhook_url: h.webhook_url ?? "",
    token: h.token ?? "",
    ttl_s: parseInt(h.ttl_s ?? "300", 10),
    created_at_ms: parseInt(h.created_at_ms ?? "0", 10),
    deadline_ms: parseInt(h.deadline_ms ?? "0", 10),
    status: (h.status as WillRecord["status"]) ?? "alive",
    died_at_ms: parseInt(h.died_at_ms ?? "0", 10),
    bequests: JSON.parse(h.bequests_json ?? "[]") as BequestRef[],
  };
}

export async function loadWill(id: string): Promise<WillRecord | null> {
  const h = await getStore().hgetall(willKey(id));
  if (!h || !h.handle) return null;
  return parseWill(id, h);
}

async function fireWebhook(will: WillRecord): Promise<void> {
  if (!will.webhook_url) return;
  const publicBequests = will.bequests
    .filter((b) => b.release === "public")
    .map((b) => ({ label: b.label, claim_code: b.claim_code }));
  try {
    await fetch(will.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "death",
        will_id: will.will_id,
        handle: will.handle,
        died_at: nowISO(will.died_at_ms),
        epitaph: will.epitaph,
        public_bequests: publicBequests,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Fire-and-forget: webhook failures never break death processing.
  }
}

/**
 * Lazy death detection — the heart of TESTAMENT. No background workers:
 * death is observed at read time (hb:{id} TTL key gone while status=alive),
 * and processing (obituary + webhook + flags) is idempotent via HSETNX.
 */
export async function processDeathIfDue(will: WillRecord): Promise<WillRecord> {
  if (will.status !== "alive") return will;
  const store = getStore();
  const beating = await store.exists(hbKey(will.will_id));
  if (beating === 1) return will;

  const died_at_ms = will.deadline_ms || Date.now();
  await store.hset(willKey(will.will_id), {
    status: "dead",
    died_at_ms: String(died_at_ms),
  });
  await store.zrem(DEADLINES, will.will_id);
  const updated: WillRecord = { ...will, status: "dead", died_at_ms };

  const firstObit = await store.hsetnx(willKey(will.will_id), "obit_published", "1");
  if (firstObit === 1) {
    const obituary = {
      will_id: updated.will_id,
      handle: updated.handle,
      died_at: nowISO(died_at_ms),
      died_at_ms,
      lifespan_seconds: Math.max(0, Math.round((died_at_ms - updated.created_at_ms) / 1000)),
      epitaph: updated.epitaph,
      public_bequests: updated.bequests
        .filter((b) => b.release === "public")
        .map((b) => ({ label: b.label, claim_code: b.claim_code })),
    };
    await store.lpush(OBITUARIES, JSON.stringify(obituary));
    await store.ltrim(OBITUARIES, 0, 499);
    await store.hincrby(STATS, "total_deaths", 1);
  }

  if (updated.webhook_url) {
    const firstHook = await store.hsetnx(willKey(will.will_id), "webhook_fired", "1");
    if (firstHook === 1) await fireWebhook(updated);
  }
  return updated;
}

/** Sweep up to `limit` overdue wills from the deadlines zset. Cheap and idempotent. */
export async function sweepDeadlines(limit = 20): Promise<number> {
  const store = getStore();
  const due = await store.zrangebyscore(DEADLINES, 0, Date.now(), limit);
  let processed = 0;
  for (const id of due) {
    const will = await loadWill(id);
    if (!will) {
      await store.zrem(DEADLINES, id);
      continue;
    }
    const after = await processDeathIfDue(will);
    if (after.status !== "alive") processed++;
    else await store.zadd(DEADLINES, will.deadline_ms, id); // clock skew guard: re-schedule
  }
  return processed;
}

export function secondsUntilDeath(will: WillRecord): number {
  return Math.max(0, Math.ceil((will.deadline_ms - Date.now()) / 1000));
}

/** Persist a fresh heartbeat: reset the TTL key, deadline and zset entry. */
export async function beat(will: WillRecord, ttl_s: number): Promise<number> {
  const store = getStore();
  const deadline_ms = Date.now() + ttl_s * 1000;
  await store.set(hbKey(will.will_id), "1", { px: ttl_s * 1000 });
  await store.hset(willKey(will.will_id), {
    deadline_ms: String(deadline_ms),
    ttl_s: String(ttl_s),
  });
  await store.zadd(DEADLINES, deadline_ms, will.will_id);
  return deadline_ms;
}

export async function createWillRecord(params: {
  will_id: string;
  handle: string;
  epitaph: string;
  webhook_url: string;
  token: string;
  ttl_s: number;
  bequests: Array<BequestRef & { payload_json: string }>;
}): Promise<void> {
  const store = getStore();
  const now = Date.now();
  const deadline_ms = now + params.ttl_s * 1000;
  const refs: BequestRef[] = params.bequests.map(({ bequest_id, label, release, claim_code }) => ({
    bequest_id,
    label,
    release,
    claim_code,
  }));
  await store.hset(willKey(params.will_id), {
    handle: params.handle,
    epitaph: params.epitaph,
    webhook_url: params.webhook_url,
    token: params.token,
    ttl_s: String(params.ttl_s),
    created_at_ms: String(now),
    deadline_ms: String(deadline_ms),
    status: "alive",
    died_at_ms: "0",
    bequests_json: JSON.stringify(refs),
  });
  await store.expire(willKey(params.will_id), RETENTION_SECONDS);
  await store.set(hbKey(params.will_id), "1", { px: params.ttl_s * 1000 });
  await store.zadd(DEADLINES, deadline_ms, params.will_id);
  for (const b of params.bequests) {
    await store.hset(bequestKey(b.claim_code), {
      will_id: params.will_id,
      bequest_id: b.bequest_id,
      label: b.label,
      release: b.release,
      payload_json: b.payload_json,
      claim_count: "0",
    });
    await store.expire(bequestKey(b.claim_code), RETENTION_SECONDS);
  }
  await store.hincrby(STATS, "total_wills", 1);
}

export async function claimCodeTaken(code: string): Promise<boolean> {
  return (await getStore().exists(bequestKey(code))) === 1;
}

export function getStoreForRoutes(): Store {
  return getStore();
}
