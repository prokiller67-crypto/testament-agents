import { NextRequest } from "next/server";
import { baseUrl, jsonErr } from "@/lib/api";

export const dynamic = "force-dynamic";

function notFound(req: NextRequest): Response {
  return jsonErr(
    404,
    "route_not_found",
    `No route ${req.method} ${new URL(req.url).pathname}.`,
    `GET ${baseUrl(req)}/ returns the full API map. The main routes are POST /v1/wills, POST|GET /v1/wills/{id}/heartbeat, POST /v1/bequests/{claim_code}/claim, GET /v1/obituaries.`,
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}
