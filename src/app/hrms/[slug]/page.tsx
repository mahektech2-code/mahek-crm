import { notFound, redirect } from "next/navigation";
import { hrmsContext } from "@/lib/hrms/access";
import { hrmsScreenBySlug } from "@/lib/hrms/registry";
import { hrmsScreenModule } from "@/lib/hrms/screens";
import { offices } from "@/lib/hrms/services/people";
import { ListScreen } from "@/app/erp/_ui/list-screen";
import { Above } from "../_ui/above";

export const dynamic = "force-dynamic";

/**
 * Every HRMS list screen. The screen's module on the server decides the rows,
 * the columns a person's powers reveal, the scope and the actions each record
 * offers; this page only checks the person holds the screen and draws it.
 */
export default async function HrmsScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const screen = hrmsScreenBySlug(slug);
  if (!screen) notFound();
  const ctx = await hrmsContext();
  if (!ctx.screens.has(screen.key)) redirect("/hrms");
  const mod = hrmsScreenModule(screen.key);
  if (!mod) notFound();

  const [{ spec, rows }, officeList] = await Promise.all([mod.load(ctx, sp), offices()]);
  const filter = sp.f ? { label: sp.fl ?? "Filtered", ids: sp.f.split(",") } : null;

  return (
    <ListScreen
      key={`${screen.key}|${sp.open ?? ""}|${sp.f ?? ""}|${sp.scope ?? ""}|${sp.date ?? ""}|${sp.month ?? ""}|${sp.from ?? ""}|${sp.to ?? ""}|${sp.who ?? ""}`}
      spec={spec}
      rows={rows}
      label={screen.label}
      sub={screen.sub}
      initialOpen={sp.open ?? null}
      filter={filter}
      godowns={officeList.map((o) => ({ v: o.name, l: o.name }))}
      above={spec.hrms ? <Above extras={spec.hrms} rows={rows} /> : null}
    />
  );
}
