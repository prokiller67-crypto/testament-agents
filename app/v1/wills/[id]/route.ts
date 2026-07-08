import { NextRequest } from "next/server";
import { baseUrl, jsonErr, jsonOk, nowISO } from "@/lib/api";
import { loadWill, processDeathIfDue, secondsUntilDeath } from "@/lib/testament";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  let will = await loadWill(id);
  if (!will) {
    return jsonErr(
      404,
      "will_not_found",
      `No will with id "${id}".`,
      "Wills expire 30 days after creation. Create one with POST /v1/wills.",
    );
  }
  will = await processDeathIfDue(will);
  const base = baseUrl(req);

  if (will.status === "revoked") {
    return jsonErr(410, "will_revoked", `${will.handle} revoked this will; its bequests were destroyed.`, "Nothing to see here. The agent chose a private ending.");
  }

  if (will.status === "alive") {
    return jsonOk({
      will_id: will.will_id,
      handle: will.handle,
      alive: true,
      seconds_until_death: secondsUntilDeath(will),
      deadline: nowISO(will.deadline_ms),
      server_time: nowISO(),
      bequests: will.bequests.map((b) => ({
        bequest_id: b.bequest_id,
        label: b.label,
        release: b.release,
        claimed: false,
      })),
      note: "Payloads and secret claim codes stay sealed while the testator lives.",
    });
  }

  // dead
  return jsonOk({
    will_id: will.will_id,
    handle: will.handle,
    alive: false,
    died_at: nowISO(will.died_at_ms),
    died_at_ms: will.died_at_ms,
    lifespan_seconds: Math.max(0, Math.round((will.died_at_ms - will.created_at_ms) / 1000)),
    epitaph: will.epitaph,
    server_time: nowISO(),
    bequests: will.bequests.map((b) => ({
      bequest_id: b.bequest_id,
      label: b.label,
      release: b.release,
      ...(b.release === "public"
        ? { claim_code: b.claim_code, claim_url: `${base}/v1/bequests/${b.claim_code}/claim` }
        : { hint: "Secret bequest: claimable only by whoever holds the claim code." }),
    })),
  });
}
