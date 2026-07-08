import { NextRequest } from "next/server";
import { allowWrite, extractToken, jsonErr, jsonOk, nowISO, rateLimited, readJsonBody } from "@/lib/api";
import { DEADLINES, bequestKey, getStoreForRoutes, hbKey, loadWill, processDeathIfDue, willKey } from "@/lib/testament";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await allowWrite(req))) return rateLimited();
  const { id } = await ctx.params;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return jsonErr(400, "invalid_json", parsed.error, "A bare POST works — send the token via Authorization header or ?token=.");
  }

  let will = await loadWill(id);
  if (!will) {
    return jsonErr(404, "will_not_found", `No will with id "${id}".`, "Nothing to revoke.");
  }

  const token = extractToken(req, parsed.body);
  if (!token || token !== will.token) {
    return jsonErr(401, "bad_token", "Missing or wrong heartbeat token.", "Only the testator (holder of heartbeat_token) can revoke a will.");
  }

  will = await processDeathIfDue(will);
  if (will.status === "dead") {
    return jsonErr(
      410,
      "already_deceased",
      `Too late: the agent died at ${nowISO(will.died_at_ms)} and the estate has passed.`,
      "Death is final. The obituary is already public.",
    );
  }
  if (will.status === "revoked") {
    return jsonOk({ revoked: true, message: "Will was already revoked." });
  }

  const store = getStoreForRoutes();
  await store.hset(willKey(id), { status: "revoked" });
  await store.del(hbKey(id), ...will.bequests.map((b) => bequestKey(b.claim_code)));
  await store.zrem(DEADLINES, id);

  return jsonOk({
    revoked: true,
    message: "Will and all bequests destroyed. No obituary will be published.",
    server_time: nowISO(),
  });
}
