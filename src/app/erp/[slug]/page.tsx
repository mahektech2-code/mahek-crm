import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpGroupOf, erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { ListScreen } from "../_ui/list-screen";

/**
 * Every list screen in the ERP. The screen's module on the server decides the
 * rows, the columns a person's powers reveal and the actions each record
 * offers; this page only checks the person holds the screen and draws it.
 */
export default async function ErpScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ f?: string; fl?: string; open?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const screen = erpScreenBySlug(slug);
  if (!screen || !screen.built) notFound();
  const mod = screenModule(screen.key);
  if (!mod) notFound();

  const ctx = await erpContext();
  if (!ctx.screens.has(screen.key)) redirect("/erp");

  const { spec, rows } = await mod.load(ctx);
  const group = erpGroupOf(screen.key);
  /* A dashboard tile opens its list pre-filtered: `f` is the ids it counted,
     `fl` what to call them. */
  const filter = sp.f ? { label: sp.fl ?? "Filtered", ids: sp.f.split(",") } : null;

  return (
    <ListScreen
      key={`${sp.open ?? ""}|${sp.f ?? ""}`}
      spec={spec}
      rows={rows}
      label={screen.label}
      crumb={`ERP · ${group?.label ?? ""}`}
      sub={screen.sub}
      initialOpen={sp.open ?? null}
      filter={filter}
      godowns={ctx.assignedGodowns.map((g) => ({ v: g.name, l: g.name }))}
    />
  );
}
