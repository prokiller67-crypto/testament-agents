import { randomBytes } from "node:crypto";
import { getStore } from "./store";

export const LIMITS = {
  heartbeat_ttl_seconds: { min: 15, default: 300, max: 604800 },
  max_bequests_per_will: 10,
  max_payload_bytes: 65536,
  max_epitaph_chars: 280,
  max_handle_chars: 64,
  max_body_bytes: 262144,
  retention_days: 30,
  writes_per_minute_per_ip: 120,
} as const;

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "cache-control": "no-store",
};

export function jsonOk(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", { status, headers: BASE_HEADERS });
}

export function jsonErr(
  status: number,
  error: string,
  message: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ error, message, hint, ...extra }, null, 2) + "\n", {
    status,
    headers: BASE_HEADERS,
  });
}

export function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function nowISO(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Tolerant JSON body reader: empty body → {}. Invalid JSON → error string. */
export async function readJsonBody(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: true, body: {} };
  }
  if (!text || text.trim() === "") return { ok: true, body: {} };
  if (text.length > LIMITS.max_body_bytes) {
    return { ok: false, error: `Request body exceeds ${LIMITS.max_body_bytes} bytes.` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Body must be a JSON object." };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Body is not valid JSON. Send application/json." };
  }
}

/** Forgiving token extraction: Authorization: Bearer > JSON body > ?token= query. */
export function extractToken(req: Request, body: Record<string, unknown>): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    return auth.trim();
  }
  if (typeof body.heartbeat_token === "string" && body.heartbeat_token) return body.heartbeat_token;
  if (typeof body.token === "string" && body.token) return body.token;
  const url = new URL(req.url);
  const q = url.searchParams.get("token") ?? url.searchParams.get("heartbeat_token");
  return q || null;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Sliding-minute write rate limit. Returns true if allowed. */
export async function allowWrite(req: Request): Promise<boolean> {
  const store = getStore();
  const key = `rl:${clientIp(req)}:${Math.floor(Date.now() / 60000)}`;
  const n = await store.incr(key);
  if (n === 1) await store.pexpire(key, 65000);
  return n <= LIMITS.writes_per_minute_per_ip;
}

export function rateLimited(): Response {
  return jsonErr(
    429,
    "rate_limited",
    `Too many write requests from this IP (limit ${LIMITS.writes_per_minute_per_ip}/min).`,
    "Wait a minute and retry. Read endpoints (GET) are not rate limited.",
    { retry_after_seconds: 60 },
  );
}

/** Public base URL as seen through Vercel's proxy. */
export function baseUrl(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}
