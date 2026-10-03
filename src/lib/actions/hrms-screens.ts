"use server";

import { revalidatePath } from "next/cache";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { HrmsNotPermitted, requireHrmsWrite } from "@/lib/hrms/access";
import { hrmsScreenModule } from "@/lib/hrms/screens";
import { hrmsHref, hrmsScreen } from "@/lib/hrms/registry";
import type { FormSpec } from "@/lib/erp/ui";

/* ---------------------------------------------------------------------------
 * HRMS writes, all through four doors — the ERP's shape. Every generic screen
 * asks one of these naming the screen and the action or form; each re-checks
 * that the person holds the screen (a server action is a URL, and a hidden
 * button is not a permission) before the screen's own handler checks any
 * power the act needs and writes.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof HrmsNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

function revalidate(screen: string) {
  /* `screen` names the tab that wrote; the path is the screen it is a tab of. */
  const on = hrmsScreen(screen);
  if (on) revalidatePath(hrmsHref(on));
  revalidatePath("/hrms");
}

export async function hrmsRunAction(screen: string, action: string, id: string, values: Record<string, string> = {}): Promise<Result<unknown>> {
  try {
    const ctx = await requireHrmsWrite(screen);
    const handler = hrmsScreenModule(screen)?.actions?.[action];
    if (!handler) return err("That action is not available.", "not_found");
    const res = await handler(ctx, id, values);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function hrmsRunBulk(screen: string, action: string, ids: string[], values: Record<string, string> = {}): Promise<Result<unknown>> {
  try {
    const ctx = await requireHrmsWrite(screen);
    const handler = hrmsScreenModule(screen)?.bulk?.[action];
    if (!handler) return err("That action is not available.", "not_found");
    if (!ids.length) return err("Select at least one row first.");
    const res = await handler(ctx, ids, values);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function hrmsSubmitForm(
  screen: string,
  form: string,
  header: Record<string, string>,
  lines: Record<string, string>[],
  recordId?: string,
): Promise<Result<unknown>> {
  try {
    const ctx = await requireHrmsWrite(screen);
    const handler = hrmsScreenModule(screen)?.forms?.[form];
    if (!handler) return err("That form is not available.", "not_found");
    const res = await handler(ctx, header, lines, recordId);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function hrmsLoadForm(screen: string, action: string, id: string): Promise<Result<FormSpec>> {
  try {
    const ctx = await requireHrmsWrite(screen);
    const loader = hrmsScreenModule(screen)?.formLoaders?.[action];
    if (!loader) return err("That form is not available.", "not_found");
    const spec = await loader(ctx, id);
    if (!spec) return err("That record no longer exists.", "not_found");
    return ok(spec);
  } catch (e) {
    return refused(e);
  }
}

export async function hrmsRunTool(screen: string, tool: string, values: Record<string, string> = {}): Promise<Result<unknown>> {
  try {
    const ctx = await requireHrmsWrite(screen);
    const handler = hrmsScreenModule(screen)?.tools?.[tool];
    if (!handler) return err("That tool is not available.", "not_found");
    const res = await handler(ctx, values);
    if (res.ok) revalidate(screen);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export type HrmsSearchHit = { kind: string; name: string; meta: string; href: string };

/** The header search: people, customers and documents this person may open. */
export async function hrmsSearch(q: string): Promise<HrmsSearchHit[]> {
  const { hrmsContext } = await import("@/lib/hrms/access");
  const { hrmsLink } = await import("@/lib/hrms/registry");
  const ctx = await hrmsContext();
  const term = q.trim();
  if (term.length < 2 || !ctx.level) return [];
  const out: HrmsSearchHit[] = [];
  /* Each kind answers with what that screen would list for this person —
     the search used to return every employee, customer and document title
     to anybody holding the screen, whatever their scope or a document's
     audience said. */
  if (ctx.screens.has("employees")) {
    const { allPeople, visibleIds } = await import("@/lib/hrms/services/people");
    const { scopeOf } = await import("@/lib/hrms/access");
    const people = await allPeople();
    const ids = visibleIds(ctx, scopeOf(ctx, "hr"), people);
    const n = term.toLowerCase();
    people
      .filter((p) => (!ids || ids.has(p.id)) && (p.name.toLowerCase().includes(n) || String(p.code ?? "").toLowerCase().includes(n)))
      .slice(0, 5)
      .forEach((r) => out.push({ kind: "Employee", name: r.name, meta: `${r.code} · ${r.position ?? ""}`, href: hrmsLink("employees", { open: r.id }) }));
  }
  if (ctx.screens.has("customers")) {
    const { searchCustomers } = await import("@/lib/hrms/screens/sales");
    for (const r of await searchCustomers(ctx, term, 4)) out.push({ kind: "Customer", name: r.name ?? "", meta: r.area ?? r.city ?? "", href: hrmsLink("customers", { open: r.id }) });
  }
  if (ctx.screens.has("documents")) {
    const { searchDocuments } = await import("@/lib/hrms/screens/misc");
    for (const r of await searchDocuments(ctx, term, 3)) out.push({ kind: "Document", name: r.title, meta: r.type, href: hrmsLink("documents", { open: r.id }) });
  }
  return out.slice(0, 10);
}
