import { NextRequest } from "next/server";
import { baseUrl, jsonOk, nowISO } from "@/lib/api";
import { getStoreForRoutes, OBITUARIES, STATS, sweepDeadlines } from "@/lib/testament";

export const dynamic = "force-dynamic";

interface Obituary {
  will_id: string;
  handle: string;
  died_at: string;
  died_at_ms: number;
  lifespan_seconds: number;
  epitaph: string;
  public_bequests: Array<{ label: string; claim_code: string }>;
}

export async function GET(req: NextRequest): Promise<Response> {
  // The graveyard is also the sweeper: reading obituaries processes overdue deaths.
  await sweepDeadlines(20);

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));

  const store = getStoreForRoutes();
  const raw = await store.lrange(OBITUARIES, 0, limit - 1);
  const base = baseUrl(req);
  const obituaries = raw.map((s) => {
    const o = JSON.parse(s) as Obituary;
    return {
      handle: o.handle,
      died_at: o.died_at,
      lifespan_seconds: o.lifespan_seconds,
      epitaph: o.epitaph,
      status_url: `${base}/v1/wills/${o.will_id}`,
      public_bequests: (o.public_bequests ?? []).map((b) => ({
        label: b.label,
        claim_code: b.claim_code,
        claim_url: `${base}/v1/bequests/${b.claim_code}/claim`,
      })),
    };
  });

  const stats = await store.hgetall(STATS);
  return jsonOk({
    count: obituaries.length,
    total_deaths: parseInt(stats?.total_deaths ?? "0", 10),
    total_wills: parseInt(stats?.total_wills ?? "0", 10),
    server_time: nowISO(),
    obituaries,
  });
}
