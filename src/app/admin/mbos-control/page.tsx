import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { allRemoteItems } from "@/lib/services/mbos-remote-service";
import { MbosControlSection, type ControlRow } from "./mbos-control-section";

export const dynamic = "force-dynamic";

/** Switches, sentences and banners on salesmen's phones, changed without a release. */
export default async function MbosControlPage() {
  await requirePlatformAdmin();
  const items = await allRemoteItems();
  const ids = [...new Set(items.flatMap((i) => [...(i.audience.userIds ?? []), ...(i.updatedById ? [i.updatedById] : [])]))];
  const people = ids.length
    ? await db.select({ id: users.id, name: users.name, email: users.email, phone: users.phone }).from(users).where(inArray(users.id, ids))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));

  const rows: ControlRow[] = items.map((i) => ({
    key: i.key,
    kind: i.kind,
    value: i.value,
    audience: {
      roles: i.audience.roles ?? [],
      people: (i.audience.userIds ?? []).map((id) => byId.get(id)?.email ?? byId.get(id)?.phone ?? id),
      peopleNames: (i.audience.userIds ?? []).map((id) => byId.get(id)?.name ?? "someone removed"),
      minVersion: i.audience.minVersion ?? "",
      maxVersion: i.audience.maxVersion ?? "",
      percent: i.audience.percent ?? 100,
    },
    enabled: i.enabled,
    note: i.note,
    updatedAt: i.updatedAt.toISOString(),
    updatedBy: i.updatedById ? (byId.get(i.updatedById)?.name ?? null) : null,
  }));

  return (
    <AdminPage
      title="MBOS control"
      subtitle="Switch features, change sentences and put banners on salesmen's phones without a new app. Phones pick a change up on their next sync, usually within minutes. Location tracking cannot be changed from here."
    >
      <MbosControlSection rows={rows} />
    </AdminPage>
  );
}
