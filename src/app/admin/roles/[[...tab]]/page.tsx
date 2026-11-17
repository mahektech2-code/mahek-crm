import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { Badge, Card, CardHeader, EmptyState, Th, Td } from "@/components/ui/primitives";
import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { APPS, type AppId } from "@/lib/apps";
import { CAPABILITIES, MATRIX, can, type Capability } from "@/lib/capability-matrix";
import { CAPABILITY_LABELS } from "@/lib/capability-labels";
import { ROLE_CONFLICTS, conflictsFor, type HeldHat } from "@/lib/role-conflicts";
import { AdminPage } from "../../_shell/admin-page";
import { requirePlatformAdmin } from "../../_shell/context";

/**
 * ROLES & PERMISSIONS — the capability matrix, read.
 *
 * The matrix lives in code (`lib/capability-matrix.ts`) and is granted on
 * People & access; this screen only says it back. Each cell is the LOWEST
 * level of that app that carries the power, so the question "who may approve
 * an order" is one row, and a capability every signed-in person holds is not
 * drawn at all — a row of ticks across the board says nothing.
 */
export default async function RolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePlatformAdmin();
  const { tab } = await params;
  const { q } = await searchParams;
  const slug = ADMIN_TABS.roles[tabIndexOf(ADMIN_TABS.roles, tab?.[0])].slug;

  const apps = (Object.keys(MATRIX) as AppId[]).filter(
    (a) => a !== "admin" && MATRIX[a].manager.length + MATRIX[a].associate.length > 0,
  );
  const shared = new Set(CAPABILITIES.filter((c) => can({ app: null, role: "associate" }, c)));
  const needle = q?.trim().toLowerCase();
  const caps = CAPABILITIES.filter((c) => !shared.has(c)).filter(
    (c) => !needle || c.includes(needle) || CAPABILITY_LABELS[c].toLowerCase().includes(needle),
  );
  const groups = groupBy(caps, (c) => c.split(".")[0]);
  const appName = (a: AppId) => APPS.find((x) => x.id === a)?.name ?? a;

  const grants = slug === "clashes" ? await clashingPeople() : [];

  return (
    <AdminPage
      title="Roles & permissions"
      subtitle="Read-only. The matrix lives in code; levels are granted on People & access."
      metrics={[
        { label: "Permissions", value: String(caps.length) },
        { label: "Apps with levels", value: String(apps.length) },
        { label: "Clashing pairs", value: String(ROLE_CONFLICTS.length), tone: "warn" },
      ]}
      tabs={{ items: ADMIN_TABS.roles, active: slug, href: (s) => ADMIN.roles(s as TabsOf<"roles">) }}
    >
      {slug === "matrix" ? (
        <Card className="overflow-hidden">
          <CardHeader
            title="Who carries each permission"
            action={
              <form className="flex items-center gap-2">
                <input
                  name="q"
                  defaultValue={q ?? ""}
                  placeholder="Find a permission"
                  aria-label="Find a permission"
                  className="ui-control h-9 w-64 rounded-control border border-line bg-surface px-3 text-sm text-ink"
                />
              </form>
            }
          />
          <div className="overflow-auto">
            <table className="[&_td]:whitespace-nowrap">
              <thead>
                <tr>
                  <Th className="sticky left-0 z-10">Permission</Th>
                  {apps.map((a) => (
                    <Th key={a} className="text-center">
                      {appName(a)}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(groups).map(([group, list]) => (
                  <Group key={group} group={group} list={list} apps={apps} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-4 border-t border-divider px-5 py-3 text-[13px] text-muted">
            <span>
              <Badge tone="neutral">A</Badge> associate and up
            </span>
            <span>
              <Badge tone="brand">M</Badge> manager and admin of that app
            </span>
            <span>Platform administrators hold every permission.</span>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {ROLE_CONFLICTS.map((c, i) => {
            const who = grants.filter((g) => g.conflicts.includes(i));
            const hat = (h: (typeof c.hats)[number]) =>
              `${appName(h.app as AppId)}${h.level ? ` ${h.level}` : ""}`;
            return (
              <Card key={i} className="overflow-hidden">
                <CardHeader
                  title={`${hat(c.hats[0])} + ${hat(c.hats[1])}`}
                  hint={c.sentence}
                  action={<Badge tone={who.length ? "warn" : "neutral"}>{who.length} {who.length === 1 ? "person" : "people"}</Badge>}
                />
                {who.length ? (
                  <ul className="divide-y divide-divider">
                    {who.map((p) => (
                      <li key={p.userId} className="flex items-center gap-3 px-5 py-3">
                        <Link href={ADMIN.person(p.userId)} className="font-semibold text-ink">
                          {p.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            );
          })}
          {ROLE_CONFLICTS.length === 0 ? <EmptyState title="No pairs are named" /> : null}
        </div>
      )}
    </AdminPage>
  );
}

function Group({ group, list, apps }: { group: string; list: Capability[]; apps: AppId[] }) {
  return (
    <>
      <tr>
        <td
          colSpan={apps.length + 1}
          className="bg-page px-4 py-2 text-xs font-semibold text-muted"
        >
          {group.charAt(0).toUpperCase() + group.slice(1)}
        </td>
      </tr>
      {list.map((c) => (
        <tr key={c} className="border-b border-divider">
          <Td className="sticky left-0 bg-surface">
            <span className="font-medium text-ink">{CAPABILITY_LABELS[c]}</span>
            <span className="ml-2 font-mono text-xs text-muted">{c}</span>
          </Td>
          {apps.map((a) => {
            const lowest = can({ app: a, role: "associate" }, c) ? "A" : can({ app: a, role: "manager" }, c) ? "M" : null;
            return (
              <Td key={a} className="text-center">
                {lowest ? (
                  <Badge tone={lowest === "A" ? "neutral" : "brand"}>{lowest}</Badge>
                ) : (
                  <span className="text-faint" aria-label="Not carried">
                    –
                  </span>
                )}
              </Td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function groupBy<T>(list: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of list) (out[key(x)] ??= []).push(x);
  return out;
}

/** Every active account whose grants put two named hats together, and which pairs. */
async function clashingPeople(): Promise<{ userId: string; name: string; conflicts: number[] }[]> {
  const rows = (await db.execute(sql`
    select u.id as user_id, u.name, a.app::text as app, coalesce(a.role::text, 'associate') as role
      from app_access a join users u on u.id = a.user_id
     where u.active`)) as unknown as { user_id: string; name: string; app: string; role: string }[];
  const byUser = new Map<string, { name: string; hats: HeldHat[] }>();
  for (const r of rows) {
    const u = byUser.get(r.user_id) ?? { name: r.name, hats: [] };
    u.hats.push({ app: r.app, role: r.role });
    byUser.set(r.user_id, u);
  }
  const out: { userId: string; name: string; conflicts: number[] }[] = [];
  for (const [userId, u] of byUser) {
    const found = conflictsFor(u.hats).map((c) => ROLE_CONFLICTS.indexOf(c));
    if (found.length) out.push({ userId, name: u.name, conflicts: found });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
