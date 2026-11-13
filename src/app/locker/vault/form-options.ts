import "server-only";
import { allAssets, lockerPeople } from "@/lib/locker/service";
import { dependentsOf } from "@/lib/locker/graph";
import { graphData } from "@/lib/locker/vault-service";
import type { IdentOpt, Opt } from "./credential-form";

/** What the add/edit login form offers: people, sign-in accounts with their weight, assets. */
export async function formOptions(): Promise<{ people: Opt[]; identities: IdentOpt[]; assets: Opt[] }> {
  const [people, g, assets] = await Promise.all([lockerPeople(), graphData(), allAssets()]);
  return {
    people: people.map((p) => ({ v: p.id, l: p.title ? `${p.name} · ${p.title}` : p.name })),
    identities: g.identities
      .map((i) => ({ id: i.id, email: i.email, provider: i.provider, controlled: i.controlled, controlledByName: i.controlledByName, deps: dependentsOf(i.id, g.creds, g.links).length }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    assets: assets.filter((a) => a.live).map((a) => ({ v: a.id, l: `${a.title} · ${a.code}` })).sort((a, b) => a.l.localeCompare(b.l)),
  };
}
