import { NextRequest } from "next/server";
import { baseUrl } from "@/lib/api";
import { skillMd } from "@/lib/skill";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest): Response {
  return new Response(skillMd(baseUrl(req)), {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
