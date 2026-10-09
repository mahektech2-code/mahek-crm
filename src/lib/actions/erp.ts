"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { db } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { erpDesignations, erpGodowns, erpUserSettings, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { godownAt, type FenceVerdict } from "@/lib/erp/engines/godown-fence";
import { err, fromThrown, okVoid, ok, type Result } from "@/lib/result";
import { ErpNotPermitted, VIEW_AS_COOKIE, erpContext, isErpAdministrator, previewRefusal, requireErpForm, requireErpWrite, setTestViewAs } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { erpScreen, erpHref, erpLink } from "@/lib/erp/registry";
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

/** A header tool on a screen: an import, a re-run, a report — anything that acts on the screen rather than one record. */
export async function erpRunTool(screen: string, tool: string, values: Record<string, string> = {}): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite(screen);
    const handler = screenModule(screen)?.tools?.[tool];
    if (!handler) return err("That tool is not available.", "not_found");
    const res = await handler(ctx, values);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpLoadForm(screen: string, action: string, id: string): Promise<Result<FormSpec>> {
  try {
    const ctx = await requireErpForm(screen);
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
    if (ctx.viewingAs) return err(previewRefusal(ctx.viewingAs), "not_permitted");
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

export type ErpLocateResult =
  | { status: "off" }
  | { status: "switched" | "already"; godown: string; metres: number }
  | Exclude<FenceVerdict, { kind: "inside" }>;

/**
 * The working location found from where somebody is standing. The browser
 * sends a fix; the fence is measured HERE, against the godowns this person is
 * assigned to, so a crafted fix can only ever pick something the header's own
 * menu would have offered. The coordinates are not stored — the audit row
 * records which godown and how far from its pin, which is what anybody asking
 * "why did my location change" needs, and nothing about where they live.
 */
export async function erpLocateWorkingGodown(fix: { lat: number; lng: number; accuracyM: number | null }): Promise<Result<ErpLocateResult>> {
  try {
    const ctx = await erpContext();
    if (!ctx.level) return err("The ERP is not on your account.", "not_permitted");
    if (ctx.viewingAs) return ok({ status: "off" });
    const config = await getConfig();
    if (!config["erp.location.autoDetect"]) return ok({ status: "off" });
    if (![fix.lat, fix.lng].every(Number.isFinite) || Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) {
      return err("That location could not be read.", "validation");
    }
    const ids = ctx.assignedGodowns.map((g) => g.id);
    const pins = ids.length
      ? await db.select({ id: erpGodowns.id, name: erpGodowns.name, lat: erpGodowns.lat, lng: erpGodowns.lng }).from(erpGodowns).where(inArray(erpGodowns.id, ids))
      : [];
    const accuracyM = fix.accuracyM != null && Number.isFinite(fix.accuracyM) ? fix.accuracyM : null;
    const v = godownAt(pins, { lat: fix.lat, lng: fix.lng, accuracyM }, config["erp.location.godownRadiusM"]);
    if (v.kind !== "inside") return ok(v);
    if (ctx.workingGodown?.id === v.godown.id) return ok({ status: "already", godown: v.godown.name, metres: v.metres });
    await db
      .insert(erpUserSettings)
      .values({ userId: ctx.user.id, workingGodownId: v.godown.id })
      .onConflictDoUpdate({ target: erpUserSettings.userId, set: { workingGodownId: v.godown.id, updatedAt: new Date() } });
    await erpAudit(ctx, "erp.workingGodown", "user", ctx.user.id, ctx.workingGodown ? { godown: ctx.workingGodown.name } : null, {
      godown: v.godown.name,
      by: "location",
      metresFromPin: v.metres,
    });
    revalidatePath("/erp", "layout");
    return ok({ status: "switched", godown: v.godown.name, metres: v.metres });
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
  const go = (key: string, open: string) => erpLink(key, { open });
  if (ctx.screens.has("customers")) {
    const rows = (await db.execute(
      sql`select id, name, city from customers where lower(name) like ${like} order by name limit 4`,
    )) as unknown as { id: string; name: string; city: string }[];
    rows.forEach((r) => out.push({ kind: "Customer", name: r.name, meta: r.city ?? "", href: go("customers", r.id) }));
  }
  if (ctx.screens.has("suppliers")) {
    const rows = (await db.execute(
      sql`select id, name, state from erp_suppliers where lower(name) like ${like} order by name limit 3`,
    )) as unknown as { id: string; name: string; state: string }[];
    rows.forEach((r) => out.push({ kind: "Supplier", name: r.name, meta: r.state ?? "", href: go("suppliers", r.id) }));
  }
  if (ctx.screens.has("rawMaterials")) {
    const rows = (await db.execute(
      sql`select id, name, material_type as t from erp_raw_materials where lower(name) like ${like} or lower(coalesce(code, '')) like ${like} order by name limit 3`,
    )) as unknown as { id: string; name: string; t: string }[];
    rows.forEach((r) => out.push({ kind: "Raw material", name: r.name, meta: r.t, href: go("rawMaterials", r.id) }));
  }
  if (ctx.screens.has("godowns")) {
    const rows = (await db.execute(
      sql`select id, name, state from erp_godowns where lower(name) like ${like} order by name limit 3`,
    )) as unknown as { id: string; name: string; state: string }[];
    rows.forEach((r) => out.push({ kind: "Godown", name: r.name, meta: r.state ?? "", href: go("godowns", r.id) }));
  }
  if (ctx.screens.has("register")) {
    const rows = (await db.execute(
      sql`select p.id, p.lot_no as lot, p.pr_number as pr, m.name as item from erp_purchases p join erp_raw_materials m on m.id = p.raw_material_id
           where lower(p.lot_no) like ${like} or p.pr_number::text = ${term} order by p.purchase_date desc limit 4`,
    )) as unknown as { id: string; lot: string; pr: number; item: string }[];
    rows.forEach((r) => out.push({ kind: "Lot", name: r.lot, meta: `PR ${r.pr} · ${r.item}`, href: go("register", r.id) }));
  }
  if (ctx.screens.has("purchaseOrders")) {
    const n = /^(?:po-?\s*)?(\d+)$/i.exec(term)?.[1];
    if (n) {
      const rows = (await db.execute(
        sql`select o.id, o.po_number as n, o.status, s.name as vendor from erp_purchase_orders o join erp_suppliers s on s.id = o.supplier_id where o.po_number::text = ${n}`,
      )) as unknown as { id: string; n: number; status: string; vendor: string }[];
      rows.forEach((r) => out.push({ kind: "PO", name: `PO-${r.n}`, meta: `${r.vendor} · ${r.status}`, href: go("purchaseOrders", r.id) }));
    }
  }
  /* Anything a label carries — a box id, a lot, a batch — opens its trace. */
  if (ctx.screens.has("trace")) {
    const { resolveTrace } = await import("@/lib/erp/traceability");
    const { erpTraceHref } = await import("@/lib/erp/trace-links");
    const hit = term.length >= 3 ? await resolveTrace(term) : null;
    const kinds: Record<string, string> = { unit: "Box", pack: "Packing batch", fg: "Refill lot", sfg: "SFG lot", rm: "Lot", order: "Order", bill: "Bill" };
    if (hit) out.unshift({ kind: kinds[hit.kind] ?? "Trace", name: hit.kind === "order" ? `Order ${hit.code}` : hit.code, meta: "Trace back and forward", href: erpTraceHref(hit.kind === "order" ? `ORDER-${hit.code}` : hit.code) });
  }
  if (ctx.screens.has("inward") && /^\d+$/.test(term)) {
    const rows = (await db.execute(
      sql`select min(i.id) as id, i.pr_number as pr, count(*)::int as n from erp_inward i where i.pr_number::text = ${term} group by i.pr_number`,
    )) as unknown as { id: string; pr: number; n: number }[];
    rows.forEach((r) => out.push({ kind: "PR", name: `PR ${r.pr}`, meta: `${r.n} inward line${r.n > 1 ? "s" : ""}`, href: go("inward", r.id) }));
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

/* ---------------------------------------------------------------------------
 * PREVIEW ACCESS AS — the design's sidebar control, made real. An ERP
 * administrator sees the ERP exactly as a designation or one person would,
 * read-only. Both doors are here; `erpContext` honours the cookie only while
 * the person holding it is still an ERP administrator.
 * ------------------------------------------------------------------------- */

const PREVIEW_HOURS = 4;

function refreshErp() {
  try {
    revalidatePath("/erp", "layout");
  } catch {
    /* outside a request, which is fine */
  }
}

export async function erpStartViewAs(target: { kind: "designation" | "user"; id: string }): Promise<Result<{ label: string }>> {
  try {
    const actor = await requireUser();
    if (!(await isErpAdministrator(actor))) return err("Only an ERP administrator can preview the ERP as somebody else.", "not_permitted");
    let label: string;
    if (target.kind === "designation") {
      const [d] = await db.select({ name: erpDesignations.name }).from(erpDesignations).where(eq(erpDesignations.id, target.id)).limit(1);
      if (!d) return err("That designation no longer exists.", "not_found");
      label = d.name;
    } else {
      if (target.id === actor.id) return erpStopViewAs().then(() => ok({ label: actor.name }));
      const [u] = await db.select({ name: users.name, active: users.active }).from(users).where(eq(users.id, target.id)).limit(1);
      if (!u || !u.active) return err("That person cannot sign in, so there is nothing to preview.", "not_found");
      if (!(await listUserApps(target.id)).includes("erp")) return err(`${u.name} does not hold the ERP.`, "validation");
      label = u.name;
    }
    const value = `${target.kind}:${target.id}`;
    if (process.env.NODE_ENV === "test") setTestViewAs(value);
    else {
      (await cookies()).set(VIEW_AS_COOKIE, value, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: PREVIEW_HOURS * 3600,
      });
    }
    await erpAudit(await erpContext(), "erp.viewAs.start", target.kind, target.id, null, { as: label });
    refreshErp();
    return ok({ label }, `Previewing the ERP as ${label} · read-only`);
  } catch (e) {
    return refused(e);
  }
}

export async function erpStopViewAs(): Promise<Result<undefined>> {
  try {
    const ctx = await erpContext();
    if (process.env.NODE_ENV === "test") setTestViewAs(null);
    else (await cookies()).delete(VIEW_AS_COOKIE);
    if (ctx.viewingAs) await erpAudit(ctx, "erp.viewAs.stop", ctx.viewingAs.kind, ctx.viewingAs.id, { as: ctx.viewingAs.label }, null);
    refreshErp();
    return okVoid("Back to your own ERP");
  } catch (e) {
    return refused(e);
  }
}
