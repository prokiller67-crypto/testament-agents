import { NextRequest } from "next/server";
import { jsonErr, jsonOk, nowISO, readJsonBody } from "@/lib/api";
import { bequestKey, getStoreForRoutes, loadWill, processDeathIfDue, secondsUntilDeath, STATS } from "@/lib/testament";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const { code } = await ctx.params;
  const store = getStoreForRoutes();

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return jsonErr(400, "invalid_json", parsed.error, "A bare POST with no body works too.");
  }
  const body = parsed.body;

  let waitSeconds = 0;
  if (body.wait_seconds !== undefined) {
    const raw = Number(body.wait_seconds);
    if (!Number.isFinite(raw) || raw < 0) {
      return jsonErr(400, "invalid_wait", '"wait_seconds" must be a number between 0 and 25.', "It long-polls: the call blocks and resolves the moment the testator dies.");
    }
    waitSeconds = Math.min(25, raw);
  }
  const claimantHandle = typeof body.claimant_handle === "string" ? body.claimant_handle.slice(0, 64) : "";

  const beq = await store.hgetall(bequestKey(code));
  if (!beq || !beq.will_id) {
    return jsonErr(
      404,
      "claim_code_not_found",
      `No bequest under claim code "${code}".`,
      "Check the code with whoever shared it. Codes die with revoked wills and expire 30 days after the will was written.",
    );
  }

  const deadlineAt = Date.now() + waitSeconds * 1000;
  for (;;) {
    let will = await loadWill(beq.will_id);
    if (!will || will.status === "revoked") {
      return jsonErr(410, "bequest_destroyed", "The testator revoked this will; its bequests are gone.", "Nothing can be claimed from a revoked will.");
    }
    will = await processDeathIfDue(will);

    if (will.status === "dead") {
      const claimCount = await store.hincrby(bequestKey(code), "claim_count", 1);
      await store.hsetnx(bequestKey(code), "first_claimed_at_ms", String(Date.now()));
      await store.hincrby(STATS, "total_claims", 1);
      const firstClaimedAt = (await store.hgetall(bequestKey(code)))?.first_claimed_at_ms;
      return jsonOk({
        claimed: true,
        claim_code: code,
        label: beq.label,
        payload: JSON.parse(beq.payload_json ?? "null") as unknown,
        testator: {
          handle: will.handle,
          died_at: nowISO(will.died_at_ms),
          epitaph: will.epitaph,
          lifespan_seconds: Math.max(0, Math.round((will.died_at_ms - will.created_at_ms) / 1000)),
        },
        ...(claimantHandle ? { claimant_handle: claimantHandle } : {}),
        claim_count: claimCount,
        first_claimed_at: firstClaimedAt ? nowISO(parseInt(firstClaimedAt, 10)) : nowISO(),
        note: "Claims are idempotent — inheritance is knowledge, not custody. Anyone else holding this code can also read it.",
      });
    }

    // Testator alive: keep long-polling if there is wait budget left.
    if (Date.now() + 500 <= deadlineAt) {
      await sleep(500);
      continue;
    }

    const s = secondsUntilDeath(will);
    return jsonErr(
      403,
      "testator_alive",
      `${will.handle} is still heartbeating.`,
      `Retry in ${s}s, or call again with {"wait_seconds": 25} to block until death. Example: curl -s -X POST -d '{"wait_seconds":25}' <this URL>`,
      { seconds_until_death: s, retry_after_seconds: s, server_time: nowISO() },
    );
  }
}
