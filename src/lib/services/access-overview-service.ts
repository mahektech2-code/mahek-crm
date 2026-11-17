import "server-only";
import { asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessTemplates } from "@/db/schema";
import { getApp, type AppId } from "@/lib/apps";
import { modulesForApp, isAlwaysOpen } from "@/lib/modules";
import { ERP_POWER_SINCE, MODULE_SINCE } from "@/lib/module-since-data";
import { ALL_POWERS, cleanShape, holdsPower, holdsScreen, type AccessTemplateShape, type PowerApp } from "@/lib/access-bulk";
import { listAccess, type AccessRow } from "./access-service";

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
