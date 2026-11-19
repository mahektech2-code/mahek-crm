import "server-only";
import { asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessTemplates } from "@/db/schema";
import { getApp, type AppId } from "@/lib/apps";
import { modulesForApp, isAlwaysOpen } from "@/lib/modules";
import { ERP_POWER_SINCE, MODULE_SINCE } from "@/lib/module-since-data";
import { ALL_POWERS, cleanShape, holdsPower, holdsScreen, type AccessTemplateShape, type PowerApp } from "@/lib/access-bulk";
import { listAccess, type AccessRow } from "./access-service";
import { ROLE_LABEL as HIRE_ROLE_LABEL, HIRE_ROLES, defaultRoleFor, type HireRole } from "@/lib/hire/roles";

/* ---------------------------------------------------------------------------
 * ACCESS FROM THE OTHER SIDE — every power and every screen, and who holds
 * it. The Access list answers "what does Puja hold"; this answers "who can
 * verify a purchase", which is the question the morning the Order Hub
 * stalled needed answered and nothing on the console could.
 *
 * Alongside the holders, the WORK WAITING on each power that routes work to
 * its holders — the purchases at Pending, the TOs waiting for a check — so a
 * power with no holder and a queue behind it is the first thing on the page.
 * An administrator holds every power of their app without a row; they are
 * counted, but separately, because a queue only an administrator can clear is
 * a queue that waits for the one person with every job.
 * ------------------------------------------------------------------------- */

export type Holder = { userId: string; name: string; how: "row" | "admin" };

export type PowerOverview = {
  id: string;
  app: PowerApp;
  appName: string;
  key: string;
  label: string;
  source: string;
  screens: { key: string; label: string }[];
  holders: Holder[];
  /** People holding the app who could be given it. */
  candidates: { userId: string; name: string }[];
  /** Work that only a holder can clear, where the power routes a queue. Null where it does not. */
  waiting: { n: number; what: string } | null;
  /** Shipped on this business day, where known — a power nobody has decided for anyone yet. */
  since: string | null;
};

export type ScreenOverview = {
  key: string;
  app: AppId;
  appName: string;
  label: string;
  group: string;
  holders: { userId: string; name: string; whole: boolean }[];
  /** Holders of the app who cannot open this screen. */
  missing: { userId: string; name: string }[];
  since: string | null;
};

export type TemplateRow = { id: string; name: string; description: string | null; shape: AccessTemplateShape; updatedAt: string };

type Waiting = Record<string, { n: number; what: string }>;

async function count(q: ReturnType<typeof sql>): Promise<number | null> {
  try {
    const r = (await db.execute(q)) as unknown as { n: number | string }[];
    return Number(r[0]?.n ?? 0);
  } catch {
    /* A queue that cannot be counted is not a reason for the page to fail. */
    return null;
  }
}

/** The queues a power routes, counted. Each is the same rule the ERP's own badge counts. */
async function waitingWork(): Promise<Waiting> {
  const q = {
    "erp.verifyPurchase": [sql`select count(*)::int as n from erp_purchases where status = 'Pending'`, "purchases at Pending"],
    "erp.verifyTest": [sql`select count(*)::int as n from erp_tests where status = 'Not Verified'`, "quality tests not verified"],
    "erp.verifyOrders": [sql`select count(*)::int as n from erp_order_intakes where status = 'open' and back_office_by_id is null`, "TOs waiting for the back-office check"],
    "erp.productionCheck": [
      sql`select ((select count(*) from erp_order_intakes where status = 'open' and production_by_id is null)
                + (select count(distinct order_no) from erp_orders where status <> 'Cancel' and source = 'erp' and accounts_check = 'Approved' and production_check = 'Pending'))::int as n`,
      "TOs and orders waiting for the Production Head",
    ],
    "erp.returnQc": [
      sql`select count(*)::int as n from erp_customer_returns r where r.status = 'open' and r.received_qty is not null and r.received_qty > coalesce((
            select sum(d.quantity) from erp_return_dispositions d where d.customer_return_id = r.id and d.status = 'active'), 0)`,
      "customer returns waiting for QC",
    ],
    "erp.returnApprove": [sql`select count(*)::int as n from erp_purchase_returns where status = 'pending'`, "supplier returns to approve"],
    "erp.dispatchOverride": [sql`select count(*)::int as n from erp_dispatch_overrides where status = 'Pending'`, "dispatch overrides to decide"],
    "erp.scrapApprove": [sql`select count(*)::int as n from erp_drum_adjustments where status = 'pending'`, "drum adjustments to approve"],
    "erp.stockControl": [sql`select count(*)::int as n from erp_stock_adjustments where status = 'pending'`, "stock adjustments to approve"],
    "erp.approveSfgQc": [
      sql`select count(distinct l.lot_code)::int as n from erp_sfg_lines l left join erp_sfg_qc q on q.lot_code = l.lot_code where coalesce(q.status, 'Pending') = 'Pending'`,
      "SFG lots waiting for QC",
    ],
  } as const;
  const entries = await Promise.all(Object.entries(q).map(async ([id, [query, what]]) => [id, await count(query), what] as const));
  const out: Waiting = {};
  for (const [id, n, what] of entries) if (n != null) out[id] = { n, what };
  return out;
}

/** The day a module shipped, where `module-since-data` knows it. */
function sinceOf(key: string): string | null {
  const v = (MODULE_SINCE as Record<string, string | undefined>)[key];
  return v ?? null;
}

const sortByName = <T extends { name: string }>(a: T[]) => a.sort((x, y) => x.name.localeCompare(y.name));

export async function accessOverview(): Promise<{ powers: PowerOverview[]; screens: ScreenOverview[]; people: { userId: string; name: string; apps: AppId[] }[] }> {
  const [rows, waiting] = await Promise.all([listAccess(), waitingWork()]);
  const active = rows.filter((r) => r.active);

  const powers: PowerOverview[] = ALL_POWERS.map((p) => {
    const holders: Holder[] = [];
    const candidates: { userId: string; name: string }[] = [];
    for (const r of active) {
      const how = holdsPower(r, p);
      if (how) holders.push({ userId: r.userId, name: r.name, how });
      else if (r.grants.some((g) => g.app === p.app)) candidates.push({ userId: r.userId, name: r.name });
    }
    return {
      id: p.id,
      app: p.app,
      appName: getApp(p.app)?.name ?? p.app,
      key: p.key,
      label: p.label,
      source: p.source,
      screens: p.screens.map((k) => ({ key: k, label: modulesForApp(p.app).find((m) => m.key === k)?.label ?? k })),
      holders: sortByName(holders),
      candidates: sortByName(candidates),
      waiting: waiting[p.id] ?? null,
      since: p.app === "erp" ? ((ERP_POWER_SINCE as Record<string, string | undefined>)[p.key] ?? null) : null,
    };
  });

  const apps = [...new Set(active.flatMap((r) => r.grants.map((g) => g.app)))];
  const screens: ScreenOverview[] = [];
  for (const app of apps) {
    for (const m of modulesForApp(app)) {
      if (isAlwaysOpen(m.key) || m.writeOf) continue;
      const holders: ScreenOverview["holders"] = [];
      const missing: ScreenOverview["missing"] = [];
      for (const r of active) {
        const g = r.grants.find((x) => x.app === app);
        if (!g) continue;
        if (holdsScreen(r, m.key)) holders.push({ userId: r.userId, name: r.name, whole: g.whole });
        else missing.push({ userId: r.userId, name: r.name });
      }
      screens.push({ key: m.key, app, appName: getApp(app)?.name ?? app, label: m.label, group: m.group ?? "", holders: sortByName(holders), missing: sortByName(missing), since: sinceOf(m.key) });
    }
  }

  const people = sortByName(active.map((r: AccessRow) => ({ userId: r.userId, name: r.name, apps: r.grants.map((g) => g.app) })));
  return { powers, screens, people };
}

export async function listAccessTemplates(): Promise<TemplateRow[]> {
  const rows = await db.select().from(accessTemplates).orderBy(asc(accessTemplates.name));
  return rows.map((t) => ({ id: t.id, name: t.name, description: t.description, shape: cleanShape(t.shape), updatedAt: t.updatedAt.toISOString() }));
}

/* ---------------------------------------------------------------------------
 * ROLES AND SEATS, from the seat's side — read-only. Four kinds of access that
 * are neither a power nor a screen, each set somewhere else (the Access dialog,
 * the ERP's masters, the Sales Dashboard), and each answering a question the
 * person's own page cannot: who is HR Head in Hire, who operates Mixing, who
 * works at the Bhiwandi godown, who oversees Gujarat. Active accounts only.
 * ------------------------------------------------------------------------- */

export type SeatPerson = { userId: string; name: string; note?: string };
export type SeatGroup = { key: string; label: string; people: SeatPerson[]; hint?: string };
export type SeatsOverview = {
  hire: SeatGroup[];
  factory: SeatGroup[];
  godowns: SeatGroup[];
  regions: SeatGroup[];
};

const FACTORY_PROC_LABEL: Record<string, string> = { mixing: "Mixing", filling: "Filling", packing: "Packing", dispatch: "Dispatch", qc: "QC", head: "Production Head" };
const CREW_ORDER = ["owner", "operator", "verifier", "helper"];
const CREW_LABEL: Record<string, string> = { owner: "In charge", operator: "Operator", verifier: "Verifier", helper: "Helper" };

async function rowsOf<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  try {
    return (await db.execute(q)) as unknown as T[];
  } catch {
    /* One list that cannot be read is not a reason for the page to fail. */
    return [];
  }
}

export async function seatsOverview(): Promise<SeatsOverview> {
  const [hire, factory, staff, godowns, regions] = await Promise.all([
    rowsOf<{ userId: string; name: string; level: string | null; role: string | null }>(sql`
      select u.id as "userId", u.name, a.role as level, r.role
        from app_access a join users u on u.id = a.user_id
        left join hire_user_roles r on r.user_id = u.id
       where a.app = 'hire' and u.active
       order by u.name`),
    rowsOf<{ userId: string; name: string; proc: string; role: string }>(sql`
      select u.id as "userId", u.name, d.proc, d.role
        from factory_team_defaults d join users u on u.id = d.user_id
       where u.active
       order by u.name`),
    rowsOf<{ userId: string; name: string; areas: string[] | null; area: string }>(sql`
      select u.id as "userId", u.name, s.areas, s.area
        from factory_staff s join users u on u.id = s.user_id
       where u.active
       order by u.name`),
    rowsOf<{ userId: string; name: string; godown: string; godownId: string; working: boolean }>(sql`
      select u.id as "userId", u.name, g.name as godown, g.id as "godownId",
             coalesce(st.working_godown_id = g.id, false) as working
        from erp_godown_staff gs
        join erp_godowns g on g.id = gs.godown_id
        join users u on u.id = gs.user_id
        left join erp_user_settings st on st.user_id = u.id
       where u.active
       order by g.name, u.name`),
    rowsOf<{ userId: string; name: string; region: string }>(sql`
      select u.id as "userId", u.name, t.region
        from mbos_user_territories t join users u on u.id = t.user_id
       where t.kind = 'region' and u.active
       order by t.region, u.name`),
  ]);

  /* Hire: the stored role, or the one the level gives where there is none — said as such. */
  const hireGroups: SeatGroup[] = HIRE_ROLES.map((r) => ({ key: r, label: HIRE_ROLE_LABEL[r], people: [] as SeatPerson[] }));
  for (const h of hire) {
    const role = (h.role as HireRole | null) ?? defaultRoleFor(h.level);
    hireGroups.find((g) => g.key === role)?.people.push({ userId: h.userId, name: h.name, note: h.role ? undefined : "by level" });
  }

  /* Factory: each department, its crew seats in order, and who works there with no seat. */
  const procs = [...new Set([...factory.map((f) => f.proc), ...staff.flatMap((s) => s.areas ?? [s.area])])].sort(
    (a, b) => Object.keys(FACTORY_PROC_LABEL).indexOf(a) - Object.keys(FACTORY_PROC_LABEL).indexOf(b),
  );
  const factoryGroups: SeatGroup[] = procs.map((proc) => {
    const seated = factory
      .filter((f) => f.proc === proc)
      .sort((a, b) => CREW_ORDER.indexOf(a.role) - CREW_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
    const unseated = staff.filter((s) => (s.areas ?? [s.area]).includes(proc) && !seated.some((x) => x.userId === s.userId));
    const people = [
      ...seated.map((f) => ({ userId: f.userId, name: f.name, note: CREW_LABEL[f.role] ?? f.role })),
      ...unseated.map((s) => ({ userId: s.userId, name: s.name, note: proc === "head" ? undefined : "no crew seat" })),
    ];
    const missing = proc === "head" ? [] : ["owner", "operator"].filter((r) => !seated.some((x) => x.role === r));
    return { key: proc, label: FACTORY_PROC_LABEL[proc] ?? proc, people, hint: missing.length ? `No ${missing.map((m) => CREW_LABEL[m].toLowerCase()).join(" or ")}` : undefined };
  });

  const byKey = <T extends { userId: string; name: string }>(rows: T[], key: (r: T) => string, note?: (r: T) => string | undefined): SeatGroup[] => {
    const out = new Map<string, SeatGroup>();
    for (const r of rows) {
      const k = key(r);
      if (!out.has(k)) out.set(k, { key: k, label: k, people: [] });
      out.get(k)!.people.push({ userId: r.userId, name: r.name, note: note?.(r) });
    }
    return [...out.values()];
  };

  return {
    hire: hireGroups,
    factory: factoryGroups,
    godowns: byKey(godowns, (g) => g.godown, (g) => (g.working ? "working here" : undefined)),
    regions: byKey(regions, (r) => r.region),
  };
}
