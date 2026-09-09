"use client";

import { Callout, Card, CardHeader, Dot } from "@/components/ui/primitives";
import { SecretCredentialRow, type SecretMeta, type SecretRow } from "./secret-credential-row";

/* ---------------------------------------------------------------------------
 * Maps credentials.
 *
 * One key, powering every Ola Maps instance in MahekOne: the Live map's
 * streets and its Snap-to-Road, Territory's shop map, which draws the book's
 * own shops and field-collected prospect pins over the same tiles, and the
 * handset's own map — including the areas a salesman saves so it still draws
 * with no signal at all.
 * `../sales/ola-maps.tsx` is where the style URLs and the authenticating
 * `transformRequest` live once, shared by both screens' components
 * (`live/street-map.tsx`, `territory/shop-map.tsx`), so this key is never
 * spent two different ways by two copies of the same logic. Without it,
 * NEITHER map draws streets — both say so plainly rather than showing a
 * blank canvas — and Snap-to-Road on top of the Live map's trail is a
 * refinement that quietly does nothing without a key either, since the raw
 * GPS line already hugs the road at this app's sampling density.
 *
 * This is also the one credential in `app_secrets` that reaches the
 * browser. Every other key here is read once, server-side, by the request
 * about to spend it, and never otherwise leaves the server. A map tile key
 * cannot follow that rule — the browser is what asks Ola Maps for squares of
 * map, over and over as somebody pans and zooms — so this key is sent down
 * to the page and is visible in the browser's network requests. That is true
 * of every map provider (Mapbox, Google, Ola), and the mitigation lives at
 * the provider, not in this codebase: restrict the key to this deployment's
 * own domain in Ola Maps' own console, so a copied key is useless elsewhere.
 * A handset has no domain to be restricted to, which is why `lib/secrets.ts`
 * asks for a second, revocable key with a spend cap rather than this one.
 *
 * ROTATING IT DOES NOT COST THE HANDSETS THEIR SAVED MAPS. MapLibre files
 * every downloaded tile under the URL it asked for, so a key baked into that
 * URL would make several hundred megabytes on a salesman's phone unreachable
 * the moment somebody changed it here — and nothing on his screen could say
 * why the map had gone blank. The handset signs its requests at the HTTP
 * layer instead, after the offline database has been consulted, so a saved
 * map is stored key-less and found key-less.
 * `mbos-app/src/data/offline-maps.ts` is where that is done, and why.
 * ------------------------------------------------------------------------- */

export type MapsData = {
  secrets: SecretRow[];
  canWrite: boolean;
};

export const MAPS_SUBTITLE =
  "The key the Live map and Territory's shop map call Ola Maps with — for the streets under both, and for laying a salesman's trail onto the road he actually walked.";

export const MAPS_TABS = [{ slug: "credentials", label: "Credentials" }];

const META: Record<string, SecretMeta> = {
  "olamaps.apiKey": {
    label: "Ola Maps",
    env: "OLAMAPS_API_KEY",
    what: 'Draws the streets under the Live map, Territory\'s shop map and the handset\'s own map (vector tiles), snaps the "today" trail of whoever a manager selects on the Live map onto the road network, and is what a phone spends when a salesman saves an area to work offline. Sent to the browser to load tiles — restrict it to this domain in Ola Maps’ own console.',
    where: "maps.olakrutrim.com → your project → API Keys",
    removalConsequence:
      "Neither the Live map nor Territory's shop map draws streets — both say so, rather than showing a blank canvas — and the trail line the Live map would otherwise snap onto the road goes back to a raw GPS line between fixes. Handsets stop being able to save new areas for offline use; what is already on a phone goes on working, because reading a saved tile back needs no key.",
  },
};

export function MapsSection({ data }: { data: MapsData }) {
  const held = data.secrets.some((s) => s.name === "olamaps.apiKey" && s.source !== "unset");

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="What is wired to it" />
        <div className="bg-surface px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Dot tone={held ? "success" : "danger"} />
            <span className="text-sm font-medium text-ink">Streets and road-snapping</span>
          </div>
          <p className="mt-1.5 text-[13px] text-pretty text-muted">
            {held
              ? "A key is set. The Live map and Territory's shop map both draw their streets from Ola Maps, the trail a manager opens on the Live map's “Everywhere they went today” is snapped onto the road network before it is drawn, and a salesman can save the areas he works so the map on his handset still draws in a market with no signal."
              : "No key is set, so neither the Live map nor Territory's shop map draws streets — both say so plainly rather than showing a blank canvas — and no handset can save an area to work offline. The team list and the shop table beside them are unaffected."}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Credentials" />
        <div className="divide-y divide-divider">
          {data.secrets.map((s) => (
            <SecretCredentialRow key={s.name} row={s} meta={META[s.name]} canWrite={data.canWrite} />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Maps kept on a handset" />
        <div className="bg-surface px-4 py-3.5">
          <p className="text-[13px] text-pretty text-muted">
            A salesman standing in a paint market has no usable signal, which is
            exactly where a map is worth most. So a handset can save the streets
            around the places its own book covers — clustered from his shops
            rather than cut to a district, because most of a district is fields
            with no shop in it — and MapLibre draws from what is on the phone
            whether or not there is a connection. It is the largest download
            this product asks anybody for, several hundred megabytes an area, so
            the size is on the row before the button is pressed and nothing goes
            over mobile data unless you allow it.
          </p>
          <p className="mt-2 text-[13px] text-pretty text-muted">
            What a phone may save is set on the Sales Dashboard, under{" "}
            <span className="text-ink">App preferences &rsaquo; Maps on the handset</span>.
            The closest zoom is the one that decides the size — every step in is
            four times the download.
          </p>
        </div>
      </Card>

      <Callout tone="warn">
        A key saved here is stored in this database as written, not encrypted. There is nowhere to
        keep an encryption key that MahekOne can read and a database backup cannot — one in the
        environment would put us back to needing shell access, which is the problem this screen
        exists to solve. Rotate it at the provider if a dump ever leaves your hands.
      </Callout>

      <Callout tone="warn">
        This is the one credential here that also reaches the browser — a map tile key has to,
        because it is the browser asking for tiles, not the server. Restrict it to this
        deployment&rsquo;s own domain in Ola Maps&rsquo; console, the same way you would a Mapbox
        or Google Maps key: that keeps a copy of it, seen in a network tab, from being spendable
        anywhere else.
      </Callout>
    </div>
  );
}
