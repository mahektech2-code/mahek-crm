import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { dropInaccurateFixes } from "@/lib/engines/trail-gaps";
import { trackForDay } from "@/lib/services/sales-service";
import { snapToRoad } from "@/lib/services/road-snap-service";

/**
 * The Live map's road-snapped trail, for one salesman on one day.
 *
 * Deliberately its own request rather than folded into `tracksForDay` (which
 * `page.tsx` reads for every salesman on every thirty-second poll of the
 * "today" view): snapping the whole team on every poll would turn one page
 * load into dozens of calls to an outside service, most of them for a trail
 * nobody has selected. This is asked once, by the client, only when a manager
 * picks a name — see `street-map.tsx`.
 *
 * A 401 or a 403 answers exactly like a missing trail: `{ points: null }`.
 * There is nothing here worth telling an attacker the shape of.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ points: null }, { status: 401 });

  const modules = await listUserModules(user.id, "sales");
  if (!modules.some((m) => m.key === "sales.live")) {
    return NextResponse.json({ points: null }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const salesmanId = params.get("salesmanId");
  const day = params.get("day");
  if (!salesmanId || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ points: null }, { status: 400 });
  }

  // Scoped inside `trackForDay` itself — a manager outside this salesman's
  // territory gets an empty day, not somebody else's trail.
  const track = await trackForDay(salesmanId, day);
  // A fix the handset itself rated as imprecise is dropped before it ever
  // reaches Snap-to-Road — see `dropInaccurateFixes`. Handing it a wildly
  // imprecise fix would have it snap that point onto whatever road happens
  // to be nearest, which is exactly the kind of invented precision the road
  // snap must never produce.
  const threshold = (await getConfig())["mbos.location.gpsAccuracyThresholdM"];
  const accurate = dropInaccurateFixes(track, threshold);
  const snapped = await snapToRoad(accurate.map((p) => ({ lat: p.lat, lng: p.lng })));

  return NextResponse.json({ points: snapped });
}
