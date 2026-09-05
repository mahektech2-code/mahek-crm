"use client";

import { Callout, Card, CardHeader, Dot } from "@/components/ui/primitives";
import { SecretCredentialRow, type SecretMeta, type SecretRow } from "./secret-credential-row";

/* ---------------------------------------------------------------------------
 * Maps credentials.
 *
 * One key so far: Ola Maps' Snap-to-Road, which lays the Live map's "today"
 * trail onto the actual road network instead of the straight lines a raw GPS
 * fix draws between two points of a street it never saw. Nothing on the map
 * BREAKS without it — the trail still draws, off the raw fixes, exactly as it
 * always has — so this is an improvement a deploy can ship without, not a
 * feature the map depends on the way dictation depends on a hearing key.
 * ------------------------------------------------------------------------- */

export type MapsData = {
  secrets: SecretRow[];
  canWrite: boolean;
};

export const MAPS_SUBTITLE =
  "The key the Live map calls Ola Maps with, to lay a salesman's trail onto the road he actually walked rather than a straight line between two GPS fixes.";

export const MAPS_TABS = [{ slug: "credentials", label: "Credentials" }];

const META: Record<string, SecretMeta> = {
  "olamaps.apiKey": {
    label: "Ola Maps",
    env: "OLAMAPS_API_KEY",
    what: "Snap-to-Road, called on the raw GPS trail for the salesman a manager has selected on the Live map's \"Everywhere they went today\" view — never on every trail on every poll, and never on the fixes stored in mbos_positions, which stay the untouched source of truth.",
    where: "maps.olakrutrim.com → your project → API Keys",
    removalConsequence:
      "The Live map's trail goes back to drawing the raw GPS line between fixes, which is what it always did without this key.",
  },
};

export function MapsSection({ data }: { data: MapsData }) {
  const held = data.secrets.some((s) => s.name === "olamaps.apiKey" && s.source !== "unset");

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="What the Live map is wired to" />
        <div className="bg-surface px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Dot tone={held ? "success" : "danger"} />
            <span className="text-sm font-medium text-ink">Road-snapping</span>
          </div>
          <p className="mt-1.5 text-[13px] text-pretty text-muted">
            {held
              ? "A key is set, so the trail a manager opens on \"Everywhere they went today\" is snapped onto the road network before it is drawn."
              : "No key is set, so the trail draws straight lines between raw GPS fixes — accurate at the fifteen-second sampling this app uses, but visibly cutting corners through buildings on a sparser one."}
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
    </div>
  );
}
