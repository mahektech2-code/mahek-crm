import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { salesSearch } from "@/lib/services/app-search-service";

/**
 * WHAT THE SALES DASHBOARD'S SEARCH BOX SEARCHES: salesmen (their record),
 * shops (the same quick view the maps open), leads (their record), products
 * and the screens this person holds — one typed list, the ERP's shape.
 *
 * The shop half is `globalSearch`, the CRM's own, so the two apps cannot
 * disagree about which shops a person may find; it is narrowed by
 * `resolveScope`, which resolves against THIS app because the proxy names it
 * from the Referer. Salesmen are `fieldTeam` and leads `leadsVisible`, both
 * narrowed by `managerScope`: a regional manager finds his own people and
 * nobody else's. Orders and bills are not offered — this app has no per-order
 * or per-bill screen for a result to land on.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ hits: [] }, { status: 401 });

  const apps = await listUserApps(user.id);
  if (!apps.includes("sales")) {
    return NextResponse.json({ hits: [] }, { status: 403 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ hits: [] });

  return NextResponse.json({ hits: await salesSearch(user.id, q) });
}
