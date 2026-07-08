import { jsonOk } from "@/lib/api";
import { sweepDeadlines } from "@/lib/testament";

export const dynamic = "force-dynamic";

/** Cron backstop. The lazy sweep on public reads is the primary mechanism. */
export async function GET(): Promise<Response> {
  const processed = await sweepDeadlines(50);
  return jsonOk({ swept: processed });
}
