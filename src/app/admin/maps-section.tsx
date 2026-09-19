"use client";

import * as React from "react";
import { Button, Callout, Card, CardHeader, Dot } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
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

/* ---------------------------------------------------------------------------
 * A POOL OF KEYS, AND A HEALTHY ONE SAYS NOTHING.
 *
 * MahekOne can hold up to five Ola accounts' keys and spends them in order,
 * moving to the next only when Ola refuses the one in force for quota. On this
 * deployment there is ONE, which is a deliberate configuration rather than an
 * unfinished one — so nothing here counts the empty slots, badges them, or
 * offers to fill them. Four grey "not set" rows under a working key is the
 * specification-sheet mistake the Live map's own handset rows already avoid:
 * a screen listing what is fine teaches people to read past the one line that
 * is there for the day something is not.
 *
 * What it DOES say is the part nobody could otherwise find out: which key is
 * being spent, which has run out, when it was refused and when it will be
 * tried again. That appears only once there is more than one key, because with
 * one there is no choice being made and nothing to report about it.
 * ------------------------------------------------------------------------- */

export type PoolKey = {
  name: string;
  /** Its place in the order keys are spent, 1 through 5. */
  position: number;
  state: "live" | "ready" | "resting";
  /** When a resting key is next tried. Null for the other two states. */
  retryAt: string | null;
  spentAt: string | null;
};

export type MapsData = {
  /** All five pool names in order; the ones nobody has set are not drawn. */
  secrets: SecretRow[];
  /** One entry per key actually HELD. Empty where none is set. */
  pool: PoolKey[];
  /** At least one key is held and Ola has refused every one of them. */
  allKeysSpent: boolean;
  canWrite: boolean;
};

export const MAPS_SUBTITLE =
  "The key the Live map and Territory's shop map call Ola Maps with — for the streets under both, and for laying a salesman's trail onto the road he actually walked.";

export const MAPS_TABS = [{ slug: "credentials", label: "Credentials" }];

const SPARE_META = (position: number): SecretMeta => ({
  label: `Ola Maps — key ${position}`,
  env: `OLAMAPS_API_KEY_${position}`,
  what: `A second Ola account's key, spent only once Ola has refused key ${
    position - 1
  } for quota. It is insurance: nothing is spread across the pool, so every account but the one in force sits at zero usage and an exhaustion is attributable to exactly one of them.`,
  where: "maps.olakrutrim.com → a separate project → API Keys",
  removalConsequence:
    "The pool gets shorter. Nothing changes today unless the keys ahead of this one have already run out, in which case the maps stop drawing streets the moment the last one does.",
});

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

function poolPosition(name: string, secrets: SecretRow[]): number {
  return secrets.findIndex((s) => s.name === name) + 1;
}

export function MapsSection({ data }: { data: MapsData }) {
  const setRows = data.secrets.filter((s) => s.source !== "unset");
  const held = setRows.length > 0;
  /* The first name nobody has set, revealed only on asking. There is no count
     beside it and no sentence saying more are available: adding an account is
     something you can do, not something you are behind on. */
  const nextSlot = data.secrets.find((s) => s.source === "unset") ?? null;
  const [addingSpare, setAddingSpare] = React.useState(false);
  /* The first row is always drawn, even unset — a deployment with no key at
     all needs somewhere to put one, and that is a real absence rather than an
     empty slot in a pool. */
  const rows = setRows.length
    ? setRows
    : data.secrets.slice(0, 1);
  const resting = data.pool.filter((k) => k.state === "resting");
  const live = data.pool.find((k) => k.state === "live") ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="What is wired to it" />
        <div className="bg-surface px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Dot tone={held && !data.allKeysSpent ? "success" : "danger"} />
            <span className="text-sm font-medium text-ink">Streets and road-snapping</span>
          </div>
          <p className="mt-1.5 text-[13px] text-pretty text-muted">
            {data.allKeysSpent
              ? "Ola has refused every key held for quota. Neither the Live map nor Territory's shop map draws streets, both say so on their own screens rather than showing a blank canvas, and no handset can save a new area to work offline. A refused key is tried again after its cooldown, and is available again from the first of next month whatever the cooldown says — so this usually clears itself. What is already saved on a phone goes on working: reading a saved tile back needs no key."
              : held
              ? "A key is set. The Live map and Territory's shop map both draw their streets from Ola Maps, the trail a manager opens on the Live map's “Everywhere they went today” is snapped onto the road network before it is drawn, and a salesman can save the areas he works so the map on his handset still draws in a market with no signal."
              : "No key is set, so neither the Live map nor Territory's shop map draws streets — both say so plainly rather than showing a blank canvas — and no handset can save an area to work offline. The team list and the shop table beside them are unaffected."}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Credentials" />
        <div className="divide-y divide-divider">
          {rows.map((s) => (
            <SecretCredentialRow
              key={s.name}
              row={s}
              meta={META[s.name] ?? SPARE_META(poolPosition(s.name, data.secrets))}
              canWrite={data.canWrite}
            />
          ))}
          {addingSpare && nextSlot ? (
            <SecretCredentialRow
              key={nextSlot.name}
              row={nextSlot}
              meta={SPARE_META(poolPosition(nextSlot.name, data.secrets))}
              canWrite={data.canWrite}
            />
          ) : null}
        </div>
        {data.canWrite && nextSlot && !addingSpare ? (
          <div className="bg-surface px-4 py-3">
            <Button variant="ghost" onClick={() => setAddingSpare(true)}>
              Add another account&rsquo;s key
            </Button>
            <p className="mt-1.5 text-[13px] text-pretty text-muted">
              A second Ola account is insurance against the first running out of
              its monthly quota. It is not extra capacity being used up in
              parallel — keys are spent one at a time, in order, and the next
              one is only reached once Ola has actually refused the one before
              it.
            </p>
          </div>
        ) : null}
      </Card>

      {data.pool.length > 1 ? (
        <Card>
          <CardHeader title="Which key is being spent" />
          <div className="divide-y divide-divider">
            {data.pool.map((k) => (
              <div key={k.name} className="flex items-baseline gap-2 bg-surface px-4 py-3">
                <Dot
                  tone={k.state === "live" ? "success" : k.state === "ready" ? "neutral" : "warn"}
                />
                <div>
                  <p className="text-sm font-medium text-ink">
                    Key {k.position}
                    {k.state === "live"
                      ? " — in use"
                      : k.state === "ready"
                        ? " — held in reserve"
                        : " — run out"}
                  </p>
                  <p className="mt-0.5 text-[13px] text-pretty text-muted">
                    {k.state === "live"
                      ? "Every Ola call MahekOne makes is being made with this one."
                      : k.state === "ready"
                        ? "Untouched. It is only reached once every key above it has been refused for quota."
                        : `Ola refused it for quota${
                            k.spentAt ? ` on ${stamp(new Date(k.spentAt))}` : ""
                          }. It will be tried again${
                            k.retryAt ? ` after ${stamp(new Date(k.retryAt))}` : ""
                          }, and is available again from the first of next month whatever that says — a quota is monthly.`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {resting.length && live ? (
        <Callout tone="warn">
          {resting.length === 1
            ? `Key ${resting[0].position} has run out and the maps are drawing on key ${live.position}.`
            : `${resting.length} keys have run out and the maps are drawing on key ${live.position}.`}{" "}
          Nothing is broken and nobody has to do anything — a quota is monthly
          and a refused key is back at the start of the next one. It is here
          because a pool that quietly shrinks to its last key is a thing to find
          out about before that happens rather than after.
        </Callout>
      ) : null}

      {data.allKeysSpent ? (
        <Callout tone="danger">
          Ola has refused every key held for quota, so nothing in MahekOne can
          draw a street or snap a trail until one of them resets at the start of
          the month or another account&rsquo;s key is added above. The maps say
          exactly this on their own screens rather than showing a blank canvas.
        </Callout>
      ) : null}

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
