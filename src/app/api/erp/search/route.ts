import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { erpSearch } from "@/lib/actions/erp";

/**
 * The ERP header's search for the shared box (`smart-search.tsx`). The rows
 * are `erpSearch`'s, already narrowed to the screens this person holds —
 * `ErpSearchHit` is the shape every app's box now draws.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ hits: [] }, { status: 401 });
  if (!(await listUserApps(user.id)).includes("erp")) return NextResponse.json({ hits: [] }, { status: 403 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ hits: await erpSearch(q) });
}
