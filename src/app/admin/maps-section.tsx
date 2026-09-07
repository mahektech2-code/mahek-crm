"use client";

import { Callout, Card, CardHeader, Dot } from "@/components/ui/primitives";
import { SecretCredentialRow, type SecretMeta, type SecretRow } from "./secret-credential-row";

/* ---------------------------------------------------------------------------
 * Maps credentials.
 *
 * One key, powering every Ola Maps instance in MahekOne: the Live map's
 * streets and its Snap-to-Road, and Territory's shop map, which draws the
 * book's own shops and field-collected prospect pins over the same tiles.
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
    what: 'Draws the streets under the Live map and Territory\'s shop map (vector tiles), and snaps the "today" trail of whoever a manager selects on the Live map onto the road network. Sent to the browser to load tiles — restrict it to this domain in Ola Maps’ own console.',
    where: "maps.olakrutrim.com → your project → API Keys",
    removalConsequence:
      "Neither the Live map nor Territory's shop map draws streets — both say so, rather than showing a blank canvas — and the trail line the Live map would otherwise snap onto the road goes back to a raw GPS line between fixes.",
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
              ? "A key is set. The Live map and Territory's shop map both draw their streets from Ola Maps, and the trail a manager opens on the Live map's “Everywhere they went today” is snapped onto the road network before it is drawn."
              : "No key is set, so neither the Live map nor Territory's shop map draws streets — both say so plainly rather than showing a blank canvas. The team list and the shop table beside them are unaffected."}
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
