import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { ListScreen } from "../_ui/list-screen";
import { screenTabs } from "../_ui/screen-tabs";
import { LIST_QUERY_KEYS, pageOf, parseListQuery } from "@/lib/erp/list-query";
import { FLAG } from "@/lib/erp/ui";
import { withReadMemo } from "@/lib/erp/read-memo";
import { scopeFor, windowInfo } from "@/lib/erp/window";
import { lightPage, lightRow, lightSpec } from "@/lib/erp/lazy-forms";

/**
 * Every list screen in the ERP. The screen's module on the server decides the
 * rows, the columns a person's powers reveal and the actions each record
 * offers; this page only checks the person holds the screen and draws it.
 *
 * A screen with tabs (`views` in the registry) draws the one `?view=` names,
 * or its first. Each tab is its own server module, so its rows and actions are
 * exactly what they were when it was a screen of its own; holding the screen
 * is what opens every tab of it.
 */
export default async function ErpScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const sp = { f: one("f"), fl: one("fl"), open: one("open"), view: one("view"), new: one("new") };
  /* `?new=1&department=…&type=…` opens the new form with those answers in it;
     the list keeps only the keys that are fields of its form. */
  const RESERVED = new Set<string>(["f", "fl", "open", "view", "new", ...LIST_QUERY_KEYS]);
  const initialNew = sp.new
    ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => !RESERVED.has(e[0]) && typeof e[1] === "string"))
    : null;
  const screen = erpScreenBySlug(slug);
  if (!screen || !screen.built) notFound();

  const ctx = await erpContext();
  if (!ctx.screens.has(screen.key)) redirect("/erp");

  const views = screen.views ?? [];
  const known = new Set(views.flatMap((v) => [v.key, ...(v.alt ? [v.alt.key] : [])]));
  const key = sp.view && known.has(sp.view) ? sp.view : (views[0]?.key ?? screen.key);
  const mod = screenModule(key);
  if (!mod) notFound();

  /* ONE PAGE travels, never the list. The search, the chip, the sort and the
     page are in the URL and read here; the browser is sent the twenty-five
     rows it draws and what it needs to say about the rest. A register is also
     READ through its window (`window.ts`): only the period's rows are built. */
  const query = parseListQuery(raw);
  /* `defer`: a heavy New form is not built for a page that would leave it on the server anyway. */
  const scope = { ...scopeFor(mod.window, query, sp.open ?? null), forms: "defer" as const };
  const [{ spec, rows, tooWide }, { tabs, toggle, sections }] = await withReadMemo(() => Promise.all([mod.load(ctx, scope), screenTabs(ctx, screen, key)]));
  /* A dashboard tile opens its list pre-filtered: `f` is the ids it counted,
     `fl` what to call them. */
  const filter = sp.f ? { label: sp.fl ?? "Filtered", ids: sp.f.split(",") } : null;
  /* Heavy forms stay on the server until somebody opens one (`lazy-forms.ts`). */
  const page = lightPage(mod, { ...pageOf(spec, rows, query, FLAG), ...(mod.window ? { window: windowInfo(mod.window, scope, tooWide ?? null) } : {}) });
  /* A folded lot opens too: its id is under its total, not at the top of the list. */
  const found = sp.open ? (rows.flatMap((r) => [r, ...(r.sub ?? [])]).find((r) => r.id === sp.open) ?? null) : null;
  const openRow = found ? lightRow(mod, found) : null;

  return (
    <ListScreen
      key={`${key}|${sp.open ?? ""}|${sp.f ?? ""}`}
      initialNew={initialNew}
      spec={lightSpec(spec)}
      rows={page.rows}
      server={{ ...page, query }}
      openRow={openRow}
      label={screen.label}
      sub={screen.sub}
      tabs={tabs}
      sections={sections}
      toggle={toggle}
      initialOpen={sp.open ?? null}
      filter={filter}
      godowns={ctx.assignedGodowns.map((g) => ({ v: g.name, l: g.name }))}
    />
  );
}
