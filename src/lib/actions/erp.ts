"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { erpUserSettings } from "@/db/schema";
import { err, fromThrown, okVoid, ok, type Result } from "@/lib/result";
import { ErpNotPermitted, erpContext, requireErpWrite } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { erpScreen, ERP_SCREENS, erpHref } from "@/lib/erp/registry";
import type { FormSpec } from "@/lib/erp/ui";
import { erpAudit } from "@/lib/erp/server";

/* ---------------------------------------------------------------------------
 * The ERP's writes, all through four doors.
 *
 * Every generic screen asks one of these, naming the screen and the action or
 * form; each re-checks that the person holds the screen (a server action is a
 * URL, and a hidden button is not a permission) before the screen's own
 * handler checks any power the act needs and writes.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

function revalidate(screen: string) {
  const s = erpScreen(screen);
  if (s) revalidatePath(erpHref(s));
  revalidatePath("/erp");
}

export async function erpRunAction(
  screen: string,
  action: string,
  id: string,
  values: Record<string, string> = {},
): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite(screen);
    const handler = screenModule(screen)?.actions?.[action];
    if (!handler) return err("That action is not available.", "not_found");
    const res = await handler(ctx, id, values);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpRunBulk(screen: string, action: string, ids: string[], values: Record<string, string> = {}): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite(screen);
    const handler = screenModule(screen)?.bulk?.[action];
    if (!handler) return err("That action is not available.", "not_found");
    if (!ids.length) return err("Nothing selected.");
    const res = await handler(ctx, ids, values);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpSubmitForm(
  screen: string,
  form: string,
  header: Record<string, string>,
  lines: Record<string, string>[],
  recordId?: string,
): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite(screen);
    const handler = screenModule(screen)?.forms?.[form];
    if (!handler) return err("That form is not available.", "not_found");
    const res = await handler(ctx, header, lines, recordId);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpLoadForm(screen: string, action: string, id: string): Promise<Result<FormSpec>> {
  try {
    const ctx = await requireErpWrite(screen);
    const loader = screenModule(screen)?.formLoaders?.[action];
    if (!loader) return err("That form is not available.", "not_found");
    const spec = await loader(ctx, id);
    if (!spec) return err("That record no longer exists.", "not_found");
    return ok(spec);
  } catch (e) {
    return refused(e);
  }
}

/** The working location (spec §2.2): only a godown the person is assigned to. */
export async function erpSetWorkingGodown(godownId: string): Promise<Result<undefined>> {
  try {
    const ctx = await erpContext();
    if (!ctx.level) return err("The ERP is not on your account.", "not_permitted");
    const g = ctx.assignedGodowns.find((x) => x.id === godownId);
    if (!g) return err("You are not assigned to that godown.", "not_permitted");
    await db
      .insert(erpUserSettings)
      .values({ userId: ctx.user.id, workingGodownId: godownId })
      .onConflictDoUpdate({ target: erpUserSettings.userId, set: { workingGodownId: godownId, updatedAt: new Date() } });
    await erpAudit(ctx, "erp.workingGodown", "user", ctx.user.id, null, { godown: g.name });
    revalidatePath("/erp", "layout");
    return okVoid(`Working location is ${g.name} · forms now pre-fill it`);
  } catch (e) {
    return refused(e);
  }
}

export type ErpSearchHit = { kind: string; name: string; meta: string; href: string };

/**
 * The header search: customers, suppliers, raw materials and godowns in
 * Phase 1; orders, lots, PRs, bills and LRs join as their screens are built.
 * Only screens the person holds are searched.
 */
export async function erpSearch(q: string): Promise<ErpSearchHit[]> {
  const ctx = await erpContext();
  const term = q.trim();
  if (term.length < 2 || !ctx.level) return [];
  const like = `%${term.toLowerCase()}%`;
  const out: ErpSearchHit[] = [];
  const { sql } = await import("drizzle-orm");
  const go = (key: string) => {
    const s = ERP_SCREENS.find((x) => x.key === key);
    return s ? erpHref(s) : "/erp";
  };
  if (ctx.screens.has("customers")) {
    const rows = (await db.execute(
      sql`select id, name, city from customers where lower(name) like ${like} order by name limit 4`,
    )) as unknown as { id: string; name: string; city: string }[];
    rows.forEach((r) => out.push({ kind: "Customer", name: r.name, meta: r.city ?? "", href: `${go("customers")}?open=${r.id}` }));
  }
  if (ctx.screens.has("suppliers")) {
    const rows = (await db.execute(
      sql`select id, name, state from erp_suppliers where lower(name) like ${like} order by name limit 3`,
    )) as unknown as { id: string; name: string; state: string }[];
    rows.forEach((r) => out.push({ kind: "Supplier", name: r.name, meta: r.state ?? "", href: `${go("suppliers")}?open=${r.id}` }));
  }
  if (ctx.screens.has("rawMaterials")) {
    const rows = (await db.execute(
      sql`select id, name, material_type as t from erp_raw_materials where lower(name) like ${like} or lower(coalesce(code, '')) like ${like} order by name limit 3`,
    )) as unknown as { id: string; name: string; t: string }[];
    rows.forEach((r) => out.push({ kind: "Raw material", name: r.name, meta: r.t, href: `${go("rawMaterials")}?open=${r.id}` }));
  }
  if (ctx.screens.has("godowns")) {
    const rows = (await db.execute(
      sql`select id, name, state from erp_godowns where lower(name) like ${like} order by name limit 3`,
    )) as unknown as { id: string; name: string; state: string }[];
    rows.forEach((r) => out.push({ kind: "Godown", name: r.name, meta: r.state ?? "", href: `${go("godowns")}?open=${r.id}` }));
  }
  if (ctx.screens.has("register")) {
    const rows = (await db.execute(
      sql`select p.id, p.lot_no as lot, p.pr_number as pr, m.name as item from erp_purchases p join erp_raw_materials m on m.id = p.raw_material_id
           where lower(p.lot_no) like ${like} or p.pr_number::text = ${term} order by p.purchase_date desc limit 4`,
    )) as unknown as { id: string; lot: string; pr: number; item: string }[];
    rows.forEach((r) => out.push({ kind: "Lot", name: r.lot, meta: `PR ${r.pr} · ${r.item}`, href: `${go("register")}?open=${r.id}` }));
  }
  if (ctx.screens.has("inward") && /^\d+$/.test(term)) {
    const rows = (await db.execute(
      sql`select min(i.id) as id, i.pr_number as pr, count(*)::int as n from erp_inward i where i.pr_number::text = ${term} group by i.pr_number`,
    )) as unknown as { id: string; pr: number; n: number }[];
    rows.forEach((r) => out.push({ kind: "PR", name: `PR ${r.pr}`, meta: `${r.n} inward line${r.n > 1 ? "s" : ""}`, href: `${go("inward")}?open=${r.id}` }));
  }
  return out.slice(0, 10);
}


/** AI-5: a question answered from the screens this person can open. Answering only. */
export async function erpAsk(question: string): Promise<{ ok: true; answer: import("@/lib/erp/ai-ask").AskAnswer } | { ok: false; error: string }> {
  const ctx = await erpContext();
  if (!ctx.level) return { ok: false, error: "The ERP is not on your account." };
  const { askErp } = await import("@/lib/erp/ai-ask");
  return askErp(ctx, question);
}
