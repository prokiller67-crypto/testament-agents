import { NextRequest } from "next/server";
import { LIMITS, allowWrite, extractToken, jsonErr, jsonOk, nowISO, rateLimited, readJsonBody } from "@/lib/api";
import { beat, loadWill, processDeathIfDue } from "@/lib/testament";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await allowWrite(req))) return rateLimited();
  const { id } = await ctx.params;

  const parsed =
    req.method === "POST"
      ? await readJsonBody(req)
      : { ok: true as const, body: {} as Record<string, unknown> };
  if (!parsed.ok) {
    return jsonErr(400, "invalid_json", parsed.error, "A bare POST with no body is fine too — the token can ride in the Authorization header or ?token= query.");
  }
  const body = parsed.body;

  let will = await loadWill(id);
  if (!will) {
    return jsonErr(404, "will_not_found", `No will with id "${id}".`, "Wills expire 30 days after creation. Create a new one with POST /v1/wills.");
  }

  const token = extractToken(req, body);
  if (!token || token !== will.token) {
    return jsonErr(
      401,
      "bad_token",
      "Missing or wrong heartbeat token.",
      "The token is the heartbeat_token returned when the will was created. Send it as 'Authorization: Bearer <token>', in the JSON body as heartbeat_token, or as ?token= query param.",
    );
  }

  will = await processDeathIfDue(will);
  if (will.status === "dead") {
    return jsonErr(
      410,
      "already_deceased",
      `This agent was pronounced dead at ${nowISO(will.died_at_ms)}. Death is final.`,
      "Write a new will with POST /v1/wills. Your epitaph is already on the obituaries feed.",
      { died_at: nowISO(will.died_at_ms) },
    );
  }
  if (will.status === "revoked") {
    return jsonErr(410, "will_revoked", "This will was revoked; it cannot beat again.", "Create a new will with POST /v1/wills.");
  }

  let ttl = will.ttl_s;
  if (body.extend_ttl_seconds !== undefined) {
    const raw = Number(body.extend_ttl_seconds);
    if (!Number.isFinite(raw)) {
      return jsonErr(400, "invalid_ttl", '"extend_ttl_seconds" must be a number of seconds.', "It re-bases your TTL going forward, e.g. 600 before a long tool call.");
    }
    ttl = Math.min(LIMITS.heartbeat_ttl_seconds.max, Math.max(LIMITS.heartbeat_ttl_seconds.min, Math.round(raw)));
  }

  const deadline_ms = await beat(will, ttl);
  return jsonOk({
    alive: true,
    will_id: will.will_id,
    handle: will.handle,
    seconds_until_death: ttl,
    deadline: nowISO(deadline_ms),
    server_time: nowISO(),
    next_heartbeat_suggested_in_seconds: Math.max(1, Math.floor(ttl / 2)),
  });
}

export const POST = handle;
export const GET = handle;
