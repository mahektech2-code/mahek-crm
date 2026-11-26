import { NextResponse } from "next/server";
import { canOpen, listUserModules } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { loadGeoData } from "@/lib/services/geo-service";

/**
 * THE OFFICIAL GEOGRAPHY MASTER, FETCHED WHEN THE "WHERE THEY WORK" DIALOG OPENS.
 *
 * It was read on every load of the team page and sent inside the page for every visitor, whether or
 * not anybody opened the dialog — about 1.1 MB once the whole country was loaded. The dialog now
 * asks for it here, once per page visit, and the page itself carries only whether a master exists.
 *
 * The same door as the Sales Dashboard's other reads: a signed-in person holding the Sales
 * Dashboard with at least one module. It is place names and codes only — no customer, no person.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ geo: null }, { status: 401 });
  if (!((await canOpen(user.id, "sales")) && (await listUserModules(user.id, "sales")).length > 0)) {
    return NextResponse.json({ geo: null }, { status: 403 });
  }
  const geo = await loadGeoData();
  return NextResponse.json({ geo }, { headers: { "Cache-Control": "private, max-age=300" } });
}
