import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { cx } from "@/components/ui/primitives";
import { ADMIN, ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { APPS, type AppId } from "@/lib/apps";
import {
  CAPABILITIES,
  MATRIX,
  can,
  type Capability,
} from "@/lib/capability-matrix";
import { CAPABILITY_LABELS } from "@/lib/capability-labels";
import {
  ROLE_CONFLICTS,
  conflictsFor,
  type HeldHat,
} from "@/lib/role-conflicts";
import { AdminPage } from "../../_shell/admin-page";
import { requirePlatformAdmin } from "../../_shell/context";
import { Avatar, Card, CardHead, Pill, Tabs } from "../../_shell/kit";
import { CsvButton } from "../csv-button";

/**
 * ROLES & PERMISSIONS — the capability matrix, read, drawn to the canvas.
 *
 * The matrix lives in code (`lib/capability-matrix.ts`) and is granted on
 * People & access; this screen only says it back. One column per level of
 * each app that carries any power — A(ssociate), M(anager), Ad(min of that
 * app) — and the platform administrator last. A capability every signed-in
 * person holds is not drawn: a row of ticks across the board says nothing.
 * Picking a permission lists everybody who holds it today, read off the real
 * grants; the clashing hats beside it are the same rule the Access review
 * uses (`lib/role-conflicts.ts`).
 */

type Level = "associate" | "manager" | "admin";
const LEVEL_SHORT: Record<Level, string> = {
  associate: "A",
  manager: "M",
  admin: "Ad",
};

export default async function RolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<{ q?: string; cap?: string; view?: string }>;
}) {
  await requirePlatformAdmin();
  const { tab } = await params;
  const { q, cap, view } = await searchParams;
  const slug = ADMIN_TABS.roles[tabIndexOf(ADMIN_TABS.roles, tab?.[0])].slug;
  const active =
    slug === "clashes" ? "clashes" : view === "people" ? "people" : "matrix";

  const appName = (a: AppId) => APPS.find((x) => x.id === a)?.name ?? a;
  const short = (a: string) =>
    a === "crm"
      ? "CRM"
      : a === "field"
        ? "Salesman"
        : (APPS.find((x) => x.id === a)?.name ?? a).split(" ")[0];

  /* The apps that carry powers of their own, and the levels each one names. */
  const apps = (Object.keys(MATRIX) as AppId[]).filter((a) => {
    const def = APPS.find((x) => x.id === a);
    return (
      a !== "admin" &&
      !def?.retiredInto &&
      MATRIX[a].manager.length + MATRIX[a].associate.length > 0
    );
  });
  const columns: Array<{ app: AppId; level: Level }> = apps.flatMap((a) =>
    (MATRIX[a].associate.length
      ? (["associate", "manager", "admin"] as Level[])
      : (["manager", "admin"] as Level[])
    ).map((level) => ({ app: a, level })),
  );

  const shared = new Set(
    CAPABILITIES.filter((c) => can({ app: null, role: "associate" }, c)),
  );
  const needle = q?.trim().toLowerCase();
  const caps = CAPABILITIES.filter((c) => !shared.has(c)).filter(
    (c) =>
      !needle ||
      c.includes(needle) ||
      CAPABILITY_LABELS[c].toLowerCase().includes(needle),
  );
  const groups = groupBy(caps, (c) => c.split(".")[0]);
  const picked: Capability | null = caps.includes(cap as Capability)
    ? (cap as Capability)
    : (caps[0] ?? null);

  const people = await grantsByPerson();
  const holders = picked
    ? people.filter(
        (p) =>
          p.platform ||
          p.hats.some((h) =>
            can({ app: h.app as AppId, role: h.role as Level }, picked),
          ),
      )
    : [];
  const clashing = people
    .map((p) => ({ ...p, clashes: conflictsFor(p.hats) }))
    .filter((p) => p.clashes.length > 0 && !p.platform);

  const hatShort = (h: HeldHat) =>
    `${short(h.app)} ${LEVEL_SHORT[(h.role as Level) ?? "associate"] ?? "A"}`;
  const capHref = (c: Capability) =>
    `${ADMIN.roles()}?${new URLSearchParams({ ...(q ? { q } : {}), cap: c }).toString()}`;

  const tabs = [
    { slug: "matrix", label: "By permission", href: ADMIN.roles() },
    {
      slug: "people",
      label: "By person",
      href: `${ADMIN.roles()}?view=people`,
    },
    { slug: "clashes", label: "Clashing hats", href: ADMIN.roles("clashes") },
    {
      slug: "powers",
      label: "Powers (ERP · HRMS · Tasks)",
      href: ADMIN.powers(),
    },
  ];

  const csvRows = caps.map((c) => [
    CAPABILITY_LABELS[c],
    c,
    ...columns.map((col) =>
      can({ app: col.app, role: col.level }, c) ? "yes" : "",
    ),
    "yes",
  ]);

  return (
    <AdminPage
      title={
        <span className="flex items-center gap-2.5">
          Roles &amp; permissions
          <Pill tone="muted">Read-only</Pill>
          <span
            title="The matrix lives in code. Grant levels on People & access."
            className="inline-flex h-5 w-5 flex-none cursor-help items-center justify-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted"
          >
            i
          </span>
        </span>
      }
      actions={
        <>
          <form>
            {active === "people" ? (
              <input type="hidden" name="view" value="people" />
            ) : null}
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Find a permission"
              aria-label="Find a permission"
              className="h-9 w-[260px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink"
            />
          </form>
          <CsvButton
            name="permissions"
            headers={[
              "Permission",
              "Key",
              ...columns.map((c) => `${short(c.app)} ${LEVEL_SHORT[c.level]}`),
              "Platform admin",
            ]}
            rows={csvRows}
            filters={[q ?? null]}
          />
        </>
      }
    >
      <Tabs items={tabs} active={active} />

      {active === "matrix" ? (
        <div
          className="grid items-start gap-[18px]"
          style={{ gridTemplateColumns: "minmax(0,1fr) 320px" }}
        >
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th
                      rowSpan={2}
                      className="bg-ink py-2 pr-1.5 pl-[18px] text-left text-xs font-semibold whitespace-nowrap text-white normal-case"
                    >
                      Permission
                    </th>
                    {apps.map((a) => (
                      <th
                        key={a}
                        colSpan={columns.filter((c) => c.app === a).length}
                        className="border-l border-[#2a3756] bg-ink px-1.5 py-2 text-center text-xs font-semibold whitespace-nowrap text-white normal-case"
                      >
                        {appName(a) === "Telecaller CRM" ? "CRM" : short(a)}
                      </th>
                    ))}
                    <th className="border-l border-[#2a3756] bg-ink px-1.5 py-2 text-center text-xs font-semibold whitespace-nowrap text-white normal-case">
                      Platform
                    </th>
                  </tr>
                  <tr>
                    {columns.map((c, i) => (
                      <th
                        key={`${c.app}.${c.level}`}
                        className={cx(
                          "bg-ink px-1.5 py-2 text-center text-xs font-semibold whitespace-nowrap text-white normal-case",
                          (i === 0 || columns[i - 1].app !== c.app) &&
                            "border-l border-[#2a3756]",
                        )}
                      >
                        {LEVEL_SHORT[c.level]}
                      </th>
                    ))}
                    <th className="border-l border-[#2a3756] bg-ink px-1.5 py-2 text-center text-xs font-semibold whitespace-nowrap text-white normal-case">
                      Admin
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(groups).map(([group, list]) => (
                    <Group
                      key={group}
                      group={group}
                      list={list}
                      columns={columns}
                      picked={picked}
                      capHref={capHref}
                    />
                  ))}
                  {caps.length === 0 ? (
                    <tr>
                      <td
                        colSpan={columns.length + 2}
                        className="h-24 text-center text-muted"
                      >
                        No permission is called that.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex flex-col gap-[18px]">
            {picked ? (
              <Card>
                <CardHead title={CAPABILITY_LABELS[picked]} />
                <div className="flex items-center gap-3 border-b border-divider px-[18px] py-3">
                  <span className="flex-1 text-muted">Held by</span>
                  <b className="text-xl font-bold text-ink">{holders.length}</b>
                </div>
                {holders.map((p) => {
                  const via = p.platform
                    ? null
                    : p.hats.find((h) =>
                        can(
                          { app: h.app as AppId, role: h.role as Level },
                          picked,
                        ),
                      );
                  return (
                    <div
                      key={p.userId}
                      className="flex items-center gap-3 border-b border-divider px-[18px] py-3 last:border-b-0"
                    >
                      <Avatar
                        name={p.name}
                        tone={p.platform ? "navy" : "brand"}
                      />
                      <Link
                        href={ADMIN.person(p.userId)}
                        className="min-w-0 flex-1 truncate font-semibold text-ink no-underline hover:underline"
                      >
                        {p.name}
                      </Link>
                      {p.platform ? (
                        <Pill tone="muted">Platform</Pill>
                      ) : via ? (
                        <Pill tone="brand">{hatShort(via)}</Pill>
                      ) : null}
                    </div>
                  );
                })}
              </Card>
            ) : null}
            <ClashCard people={clashing} hatShort={hatShort} />
          </div>
        </div>
      ) : active === "people" ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Person", "Hats", "Permissions held", "Clashes"].map(
                    (h) => (
                      <th
                        key={h}
                        className="bg-ink px-[18px] py-[9px] text-left text-xs font-semibold whitespace-nowrap text-white normal-case"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {people
                  .filter(
                    (p) => !needle || p.name.toLowerCase().includes(needle),
                  )
                  .map((p) => {
                    const held = p.platform
                      ? caps.length
                      : caps.filter((c) =>
                          p.hats.some((h) =>
                            can(
                              { app: h.app as AppId, role: h.role as Level },
                              c,
                            ),
                          ),
                        ).length;
                    const clashes = p.platform
                      ? 0
                      : conflictsFor(p.hats).length;
                    return (
                      <tr key={p.userId}>
                        <td className="h-10 border-b border-divider px-[18px]">
                          <span className="flex items-center gap-3">
                            <Avatar
                              name={p.name}
                              tone={p.platform ? "navy" : "brand"}
                            />
                            <Link
                              href={ADMIN.person(p.userId)}
                              className="font-semibold text-ink no-underline hover:underline"
                            >
                              {p.name}
                            </Link>
                          </span>
                        </td>
                        <td className="h-10 border-b border-divider px-[18px]">
                          <span className="flex flex-wrap gap-1.5 py-1.5">
                            {p.platform ? (
                              <Pill tone="muted">Platform</Pill>
                            ) : null}
                            {p.hats
                              .filter((h) =>
                                columns.some((c) => c.app === h.app),
                              )
                              .map((h) => (
                                <Pill key={h.app} tone="brand">
                                  {hatShort(h)}
                                </Pill>
                              ))}
                          </span>
                        </td>
                        <td className="h-10 border-b border-divider px-[18px] font-semibold text-ink tabular-nums">
                          {held}
                        </td>
                        <td className="h-10 border-b border-divider px-[18px]">
                          {clashes ? (
                            <Pill tone="warn">{clashes}</Pill>
                          ) : (
                            <span className="text-faint">–</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-[18px]">
          {ROLE_CONFLICTS.map((c, i) => {
            const who = clashing.filter((p) => p.clashes.includes(c));
            const hat = (h: (typeof c.hats)[number]) =>
              `${short(h.app)}${h.level ? ` ${LEVEL_SHORT[h.level as Level] ?? h.level}` : ""}`;
            return (
              <Card key={i}>
                <CardHead title={`${hat(c.hats[0])} + ${hat(c.hats[1])}`}>
                  <span
                    title={c.sentence}
                    className="inline-flex h-5 w-5 flex-none cursor-help items-center justify-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted"
                  >
                    i
                  </span>
                </CardHead>
                {who.length ? (
                  who.map((p) => (
                    <div
                      key={p.userId}
                      className="flex items-center gap-3 border-b border-divider px-[18px] py-3 last:border-b-0"
                    >
                      <Avatar name={p.name} />
                      <Link
                        href={ADMIN.person(p.userId)}
                        className="flex-1 font-semibold text-ink no-underline hover:underline"
                      >
                        {p.name}
                      </Link>
                      <span className="text-muted">
                        {p.hats.map(hatShort).join(" + ")}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="px-[18px] py-3 text-muted">
                    Nobody holds both.
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </AdminPage>
  );
}

function Group({
  group,
  list,
  columns,
  picked,
  capHref,
}: {
  group: string;
  list: Capability[];
  columns: Array<{ app: AppId; level: Level }>;
  picked: Capability | null;
  capHref: (c: Capability) => string;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={columns.length + 2}
          style={{ textTransform: "uppercase" }}
          className="h-[34px] border-b border-divider bg-page pl-[18px] text-xs font-semibold tracking-[0.05em] text-muted"
        >
          {group.replace(/([a-z])([A-Z])/g, "$1 $2")}
        </td>
      </tr>
      {list.map((c) => {
        const on = c === picked;
        return (
          <tr key={c} className={on ? "[&>td]:bg-[#f7f5ff]" : undefined}>
            <td className="h-10 border-b border-divider pr-1.5 pl-[18px] text-left whitespace-nowrap">
              <Link
                href={capHref(c)}
                title={c}
                className="font-semibold text-ink no-underline hover:underline"
              >
                {CAPABILITY_LABELS[c]}
              </Link>
            </td>
            {columns.map((col, i) => (
              <Cell
                key={`${col.app}.${col.level}`}
                yes={can({ app: col.app, role: col.level }, c)}
                left={i === 0 || columns[i - 1].app !== col.app}
              />
            ))}
            <Cell yes left />
          </tr>
        );
      })}
    </>
  );
}

function Cell({ yes, left }: { yes: boolean; left: boolean }) {
  return (
    <td
      className={cx(
        "h-10 border-b border-divider px-1.5 text-center",
        left && "border-l border-l-divider",
      )}
    >
      {yes ? (
        <span className="font-bold text-success" aria-label="Carried">
          ✓
        </span>
      ) : (
        <span className="text-[#b8c2d3]" aria-label="Not carried">
          –
        </span>
      )}
    </td>
  );
}

function ClashCard({
  people,
  hatShort,
}: {
  people: Array<Person & { clashes: unknown[] }>;
  hatShort: (h: HeldHat) => string;
}) {
  return (
    <Card>
      <CardHead
        title="Clashing hats"
        actions={
          <Pill tone={people.length ? "warn" : "muted"}>{people.length}</Pill>
        }
      />
      {people.length ? (
        people.map((p) => (
          <Link
            key={p.userId}
            href={ADMIN.person(p.userId)}
            className="block border-b border-divider px-[18px] py-3 no-underline last:border-b-0 hover:bg-page"
          >
            <b className="font-semibold text-ink">{p.name}</b>
            <div className="text-muted">{p.hats.map(hatShort).join(" + ")}</div>
          </Link>
        ))
      ) : (
        <div className="px-[18px] py-3 text-muted">
          Nobody holds two hats that should not meet.
        </div>
      )}
    </Card>
  );
}

function groupBy<T>(list: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of list) (out[key(x)] ??= []).push(x);
  return out;
}

type Person = {
  userId: string;
  name: string;
  hats: HeldHat[];
  platform: boolean;
};

/** Every active account's grants, and whether it is the platform administrator. */
async function grantsByPerson(): Promise<Person[]> {
  const rows = (await db.execute(sql`
    select u.id as user_id, u.name, a.app::text as app, coalesce(a.role::text, 'associate') as role
      from app_access a join users u on u.id = a.user_id
     where u.active
     order by u.name`)) as unknown as {
    user_id: string;
    name: string;
    app: string;
    role: string;
  }[];
  const byUser = new Map<string, Person>();
  for (const r of rows) {
    const u = byUser.get(r.user_id) ?? {
      userId: r.user_id,
      name: r.name,
      hats: [],
      platform: false,
    };
    if (r.app === "admin" && r.role === "admin") u.platform = true;
    else u.hats.push({ app: r.app, role: r.role });
    byUser.set(r.user_id, u);
  }
  return [...byUser.values()];
}
