import "server-only";
import type { ErpContext } from "./access";
import type { ScreenModule } from "./server";
import { NEW_FORM_ACTION, type ActionSpec, type FormSpec, type ListRow, type ListSpec } from "./ui";
import { parseListQuery } from "./list-query";
import { scopeFor, type LoadScope } from "./window";
import { withReadMemo } from "./read-memo";

/* ---------------------------------------------------------------------------
 * A FORM NOBODY HAS OPENED IS NOT SENT.
 *
 * A list's New form and a record's action forms carry their option lists —
 * every customer, every lot, every bill a return could name — and they used to
 * travel with the list on every visit: 4 MB with Customer returns, 870 KB with
 * Complaints, 650 KB with Transfers, 30 KB per row on Goods receipt. All of it
 * serialised on a single shared core, sent down a factory's Wi-Fi and parsed
 * by a tablet, to draw a list of twenty-five rows, when the form is opened on
 * one visit in many. It is the CRM's Add customer dialog over again.
 *
 * So a form heavier than `LAZY_FORM_BYTES` stays on the server: the list says
 * there is one (`newFormLazy`, an action's `loadsForm`), and pressing the
 * button asks for it through `erpLoadForm`. What comes back is the form the
 * screen module builds — the same module, the same person, the same period —
 * so it cannot differ from the one that used to be embedded. A light form
 * still travels with the list and opens with no round trip.
 * ------------------------------------------------------------------------- */

export const LAZY_FORM_BYTES = 12_000;

/**
 * A heavy New form that exists for everybody who reaches the list: built when
 * it is asked for, and only said to exist when the page is going to leave it
 * on the server anyway (`LoadScope.forms`). Building it was most of what these
 * lists cost the server — every customer, every returnable line, every lot in
 * stock read to fill option lists nobody had opened.
 */
export async function newFormIn(scope: LoadScope | undefined, build: () => Promise<FormSpec>): Promise<Pick<ListSpec, "newForm" | "newFormLazy">> {
  return scope?.forms === "defer" ? { newFormLazy: true } : { newForm: await build() };
}

function heavy(f: FormSpec | undefined): f is FormSpec {
  return !!f && JSON.stringify(f).length > LAZY_FORM_BYTES;
}

/** The list's own New form left on the server when it is heavy. */
export function lightSpec(spec: ListSpec): ListSpec {
  if (!heavy(spec.newForm)) return spec;
  return { ...spec, newForm: undefined, newFormLazy: true };
}

function lightAction(mod: ScreenModule, a: ActionSpec): ActionSpec {
  /* An action the module already loads on demand answers under its own loader; it is never re-routed. */
  if (!heavy(a.form) || mod.formLoaders?.[a.id]) return a;
  return { ...a, form: undefined, loadsForm: true };
}

/** A row as it is sent: its heavy action forms left on the server, its folded rows the same. */
export function lightRow(mod: ScreenModule, r: ListRow): ListRow {
  const actions = r.actions?.map((a) => lightAction(mod, a));
  const sub = r.sub?.map((x) => lightRow(mod, x));
  return { ...r, ...(actions ? { actions } : {}), ...(sub ? { sub } : {}) };
}

/**
 * A form that was left on the server, built again by the screen's module. The
 * New form is asked for under `NEW_FORM_ACTION` with the list's period as its
 * id; a record's under the action's own id with the record's, read the way a
 * link to it opens it (`open`), so a record outside the default period is
 * still found.
 */
export async function lazyForm(ctx: ErpContext, mod: ScreenModule, action: string, id: string): Promise<FormSpec | null> {
  if (action === NEW_FORM_ACTION) {
    const { spec } = await withReadMemo(() => mod.load(ctx, scopeFor(mod.window, parseListQuery({ pd: id }), null)));
    return spec.newForm ?? null;
  }
  const { rows } = await withReadMemo(() => mod.load(ctx, scopeFor(mod.window, parseListQuery({}), id)));
  const row = rows.flatMap((r) => [r, ...(r.sub ?? [])]).find((r) => r.id === id);
  return row?.actions?.find((a) => a.id === action)?.form ?? null;
}

/** A list page as it is sent: its rows lightened (the same rows `server.rows` carries, so they travel once). */
export function lightPage<P extends { rows: ListRow[] }>(mod: ScreenModule, p: P): P {
  return { ...p, rows: p.rows.map((r) => lightRow(mod, r)) };
}
