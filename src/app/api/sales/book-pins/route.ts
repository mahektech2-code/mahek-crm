import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { shopPins } from "@/lib/services/sales-service";

/**
 * The shops and leads AROUND THE TEAM, for the Live map to draw beneath the
 * day.
 *
 * **A catchment, not the book.** The whole book on a live map is a wash of
 * dots that answers nothing: the question this layer exists for is what a
 * salesman is standing next to and what he walked past, so it is drawn
 * within `mbos.location.nearbyBookRadiusKm` of where each man actually is.
 * Territory is where the whole book is read, and it calls `shopPins` with no
 * catchment at all.
 *
 * **The client sends the centres because the client is what has them.** The
 * positions are already on that page — `lastKnownPositions`, drawn as the
 * salesman pins — so asking the server to read them again would be a second
 * answer to "where is everybody" that could differ from the one on screen by
 * a poll. They are only a catchment: nothing is revealed by them that the
 * caller did not already have, and what comes back is narrowed by
 * `managerScope` inside `shopPins` regardless of what was sent.
 *
 * **A REQUEST RATHER THAN A PROP.** `/sales/live` used to re-run its Server
 * Component every thirty seconds while the tab is open, re-serialising
 * everything that page hands the map into each of those answers. It is told
 * what has arrived instead now (see `live-panel.tsx`), which removes that cost
 * and leaves this reasoning standing: the shops do not move. Asked by the client
 * instead, once, and again only when the team has moved far enough for the
 * catchment to mean somewhere else.
 *
 * **The `sales` grant is asked first, not `managerScope`.** That narrowing is
 * vacuous for anybody with no `region` row — which is nearly every plain
 * salesman — so a route leaning on it alone would hand the customer book to
 * anyone signed in. Same lesson `attachment-service.ts` records about
 * check-in selfies, arriving at a different door: the grant decides whether
 * there is a screen for this at all, and the scope only narrows what that
 * screen shows.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** How many positions a catchment may be built from. */
const MAX_CENTRES = 60;

/** `lat,lng|lat,lng` → the centres, with anything unreadable dropped. */
function parseCentres(raw: string | null): Array<{ lat: number; lng: number }> {
  if (!raw) return [];
  return raw
    .split("|")
    .slice(0, MAX_CENTRES)
    .map((pair) => {
      const [lat, lng] = pair.split(",").map(Number);
      return { lat, lng };
    })
    .filter(
      (c) =>
        Number.isFinite(c.lat) &&
        Number.isFinite(c.lng) &&
        Math.abs(c.lat) <= 90 &&
        Math.abs(c.lng) <= 180,
    );
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ pins: [] }, { status: 401, ...NO_STORE });

  /* The `sales` GRANT and the `sales.live` module together, in that order —
     see `canOpenModule`. Asking `listUserModules` alone answers "every module"
     for somebody who holds none of the app. */
  if (!(await canOpenModule(user.id, "sales.live"))) {
    return NextResponse.json({ pins: [] }, { status: 403, ...NO_STORE });
  }

  const centres = parseCentres(new URL(request.url).searchParams.get("near"));
  /* Nobody in the field is nothing to be near. `shopPins` reads an empty
     catchment as exactly that rather than as "everywhere" — see its own
     note — and answering it here as well would be a second copy of that
     decision. */
  const config = await getConfig();
  const pins = await shopPins({
    /* EVERY status and every kind, which is not this route's decision to
       make: `shopPins` stopped filtering in SQL at all — a map that quietly
       omits three quarters of the pins is one somebody plans a day from and
       is wrong. What this route narrows is WHERE, and nothing else. */
    near: { centres, radiusKm: config["mbos.location.nearbyBookRadiusKm"] },
  });

  return NextResponse.json(
    { pins, radiusKm: config["mbos.location.nearbyBookRadiusKm"] },
    NO_STORE,
  );
}
