import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpHref, erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { ListScreen, type ListTab } from "../_ui/list-screen";

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
  searchParams: Promise<{ f?: string; fl?: string; open?: string; view?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const screen = erpScreenBySlug(slug);
  if (!screen || !screen.built) notFound();

  const ctx = await erpContext();
  if (!ctx.screens.has(screen.key)) redirect("/erp");

  const views = screen.views ?? [];
  const known = new Set(views.flatMap((v) => [v.key, ...(v.alt ? [v.alt.key] : [])]));
  const key = sp.view && known.has(sp.view) ? sp.view : (views[0]?.key ?? screen.key);
  const mod = screenModule(key);
  if (!mod) notFound();

  const { spec, rows } = await mod.load(ctx);
  /* A dashboard tile opens its list pre-filtered: `f` is the ids it counted,
     `fl` what to call them. */
  const filter = sp.f ? { label: sp.fl ?? "Filtered", ids: sp.f.split(",") } : null;

  const base = erpHref(screen);
  const at = (k: string) => (k === views[0]?.key ? base : `${base}?view=${k}`);
  const tabs: ListTab[] = views.map((v) => ({ key: v.key, label: v.label, href: at(v.key), active: v.key === key || v.alt?.key === key }));
  const current = views.find((v) => v.key === key || v.alt?.key === key);
  const toggle = current?.alt ? (current.alt.key === key ? { label: current.alt.back, href: at(current.key) } : { label: current.alt.label, href: at(current.alt.key) }) : null;

  return (
    <ListScreen
      key={`${key}|${sp.open ?? ""}|${sp.f ?? ""}`}
      spec={spec}
      rows={rows}
      label={screen.label}
      sub={screen.sub}
      tabs={tabs}
      toggle={toggle}
      initialOpen={sp.open ?? null}
      filter={filter}
      godowns={ctx.assignedGodowns.map((g) => ({ v: g.name, l: g.name }))}
    />
  );
}
