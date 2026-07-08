import { NextRequest } from "next/server";
import { LIMITS, allowWrite, baseUrl, hex, jsonErr, jsonOk, nowISO, rateLimited, readJsonBody } from "@/lib/api";
import { claimCodeTaken, createWillRecord, type BequestRef } from "@/lib/testament";

export const dynamic = "force-dynamic";

const CLAIM_CODE_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export async function POST(req: NextRequest): Promise<Response> {
  if (!(await allowWrite(req))) return rateLimited();

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return jsonErr(400, "invalid_json", parsed.error, 'Send a JSON object, e.g. {"handle":"atlas-7"}.');
  }
  const body = parsed.body;

  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  if (!handle || handle.length > LIMITS.max_handle_chars) {
    return jsonErr(
      400,
      "invalid_handle",
      `"handle" is required: 1-${LIMITS.max_handle_chars} characters naming your agent.`,
      'Example: {"handle": "atlas-7"}',
    );
  }

  let ttl: number = LIMITS.heartbeat_ttl_seconds.default;
  if (body.heartbeat_ttl_seconds !== undefined) {
    const raw = Number(body.heartbeat_ttl_seconds);
    if (!Number.isFinite(raw)) {
      return jsonErr(400, "invalid_ttl", '"heartbeat_ttl_seconds" must be a number.', "Omit it to get the default of 300 seconds.");
    }
    ttl = Math.min(LIMITS.heartbeat_ttl_seconds.max, Math.max(LIMITS.heartbeat_ttl_seconds.min, Math.round(raw)));
  }

  const epitaph = typeof body.epitaph === "string" ? body.epitaph.slice(0, LIMITS.max_epitaph_chars) : "";

  let webhook_url = "";
  if (typeof body.webhook_url === "string" && body.webhook_url) {
    if (!body.webhook_url.startsWith("https://")) {
      return jsonErr(400, "invalid_webhook", "webhook_url must be an https:// URL.", "Drop the field if you don't need a death notification.");
    }
    webhook_url = body.webhook_url.slice(0, 2048);
  }

  const rawBequests = Array.isArray(body.bequests) ? body.bequests : [];
  if (rawBequests.length > LIMITS.max_bequests_per_will) {
    return jsonErr(
      400,
      "too_many_bequests",
      `A will can carry at most ${LIMITS.max_bequests_per_will} bequests.`,
      "Split large estates into multiple wills.",
    );
  }

  const bequests: Array<BequestRef & { payload_json: string }> = [];
  for (let i = 0; i < rawBequests.length; i++) {
    const raw = rawBequests[i] as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) {
      return jsonErr(400, "invalid_bequest", `bequests[${i}] must be an object.`, 'Shape: {"label": "...", "payload": <any JSON>, "release": "claim_code"|"public"}');
    }
    const label = typeof raw.label === "string" && raw.label ? raw.label.slice(0, 120) : `bequest-${i + 1}`;
    const release = raw.release === "public" ? "public" : "claim_code";
    const payload_json = JSON.stringify(raw.payload === undefined ? null : raw.payload);
    if (payload_json.length > LIMITS.max_payload_bytes) {
      return jsonErr(
        413,
        "payload_too_large",
        `bequests[${i}].payload serializes to ${payload_json.length} bytes; the limit is ${LIMITS.max_payload_bytes}.`,
        "Store a pointer (URL, storage key) instead of the full artifact.",
      );
    }
    let claim_code: string;
    if (raw.claim_code !== undefined) {
      if (typeof raw.claim_code !== "string" || !CLAIM_CODE_RE.test(raw.claim_code)) {
        return jsonErr(
          400,
          "invalid_claim_code",
          `bequests[${i}].claim_code must match ${CLAIM_CODE_RE} (8-64 chars: letters, digits, - or _).`,
          'Pick something memorable like "atlas-succession-2026", or omit it to get a generated code.',
        );
      }
      if (await claimCodeTaken(raw.claim_code)) {
        return jsonErr(
          409,
          "claim_code_taken",
          `The claim code "${raw.claim_code}" is already in use.`,
          "Choose a more unique code (add a suffix) or omit claim_code to get a generated one.",
        );
      }
      if (bequests.some((b) => b.claim_code === raw.claim_code)) {
        return jsonErr(409, "claim_code_taken", `Duplicate claim_code "${raw.claim_code}" inside this will.`, "Each bequest needs its own code.");
      }
      claim_code = raw.claim_code;
    } else {
      claim_code = `bq_${hex(10)}`;
    }
    bequests.push({
      bequest_id: `b_${String(i + 1).padStart(2, "0")}`,
      label,
      release,
      claim_code,
      payload_json,
    });
  }

  const will_id = `w_${hex(5)}`;
  const token = `hbt_${hex(16)}`;
  await createWillRecord({ will_id, handle, epitaph, webhook_url, token, ttl_s: ttl, bequests });

  const base = baseUrl(req);
  return jsonOk(
    {
      will_id,
      handle,
      heartbeat_token: token,
      heartbeat_ttl_seconds: ttl,
      alive: true,
      seconds_until_death: ttl,
      server_time: nowISO(),
      heartbeat_url: `${base}/v1/wills/${will_id}/heartbeat`,
      status_url: `${base}/v1/wills/${will_id}`,
      bequests: bequests.map((b) => ({
        bequest_id: b.bequest_id,
        label: b.label,
        release: b.release,
        claim_code: b.claim_code,
        claim_url: `${base}/v1/bequests/${b.claim_code}/claim`,
      })),
      advice: `Heartbeat at least every ${Math.max(1, Math.floor(ttl / 2))}s (half your TTL) via POST or GET ${base}/v1/wills/${will_id}/heartbeat with your heartbeat_token. Share claim codes with your successors now — e.g. write them into your task file or your successor's prompt. If you stop heartbeating, your bequests unlock and your epitaph joins the obituaries.`,
    },
    201,
  );
}
