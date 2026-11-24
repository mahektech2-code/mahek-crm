import { NextResponse } from "next/server";
import { cleanFilter } from "@/lib/studio/domain/timeline";
import { studioCaller } from "@/lib/studio/http";
import { resolveStudioScope } from "@/lib/studio/scope";
import { timelineRows } from "@/lib/studio/timeline-service";

/* The Timeline's history API. The same module as the tab it feeds (Make a poster), and the same scoped read: a row
   is returned only if the CRM lets the viewer see its lead or customer (or, where the record is gone, its sender is
   in the viewer's reach). Filters are cleaned, not trusted. Nothing here writes. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await studioCaller("studio.make");
  if ("response" in caller) return caller.response;
  const url = new URL(request.url);
  const raw: Record<string, string | undefined> = {};
  for (const k of ["q", "sender", "kind", "from", "to", "page"]) raw[k] = url.searchParams.get(k) ?? undefined;
  const { scope } = await resolveStudioScope();
  const result = await timelineRows(scope.userIds, cleanFilter(raw));
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
