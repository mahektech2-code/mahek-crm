import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/primitives";
import { ListTabs, type ListTab } from "@/app/erp/_ui/list-screen";
import { hrmsContext } from "@/lib/hrms/access";
import { hrmsNavCounts } from "@/lib/hrms/counts";
import { hrmsScreenBySlug } from "@/lib/hrms/registry";
import { hrmsScreenModule } from "@/lib/hrms/screens";
import { offices } from "@/lib/hrms/services/people";
import { hrmsModuleTitle } from "./title";
import { HrmsList } from "../_ui/hrms-list";
import { SettingsView } from "../_ui/settings-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ view?: string }> }) {
  return { title: hrmsModuleTitle((await params).slug, (await searchParams).view) };
}

/** The tabs that are not lists, and what draws them. */
const CUSTOM_TABS: Record<string, () => Promise<React.ReactNode>> = {
  settings: async () => <SettingsView />,
};

/**
 * Every HRMS screen. The screen's module on the server decides the rows, the
 * columns a person's powers reveal, the scope and the actions each record
 * offers; this page only checks the person holds the screen and draws it.
 *
 * A screen with tabs draws the one `?view=` names, or its first. Each tab is
 * its own server module, so its rows and actions are exactly what they were
 * when it was a screen of its own; holding the screen is what opens every tab.
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
  if (!screen || screen.view === "custom") notFound();
  const ctx = await hrmsContext();
  if (!ctx.screens.has(screen.key)) redirect("/hrms");

  const views = (screen.views ?? []).filter((v) => ctx.screens.has(v.key));
  const current = views.find((v) => v.key === sp.view) ?? views[0] ?? null;
  const key = current?.key ?? screen.key;
  const sub = current?.sub ?? screen.sub;

  const counts = await hrmsNavCounts(ctx);
  const base = `/hrms/${screen.slug}`;
  const tabs: ListTab[] = views.map((v, i) => ({
    key: v.key,
    label: v.label,
    href: i === 0 ? base : `${base}?view=${v.key}`,
    active: v.key === key,
    count: counts[v.key] ?? 0,
  }));

  if (current?.view === "custom") {
    const draw = CUSTOM_TABS[current.key];
    if (!draw) notFound();
    return (
      <div className="px-6 pt-6 pb-10">
        <PageHeader title={screen.label} subtitle={sub} />
        {tabs.length > 1 ? <ListTabs label={screen.label} tabs={tabs} /> : null}
        {await draw()}
      </div>
    );
  }

  const mod = hrmsScreenModule(key);
  if (!mod) notFound();
  const [{ spec, rows }, officeList] = await Promise.all([mod.load(ctx, sp), offices()]);
  const filter = sp.f ? { label: sp.fl ?? "Filtered", ids: sp.f.split(",") } : null;

  return (
    <HrmsList
      key={`${key}|${sp.open ?? ""}|${sp.f ?? ""}|${sp.scope ?? ""}|${sp.date ?? ""}|${sp.month ?? ""}|${sp.from ?? ""}|${sp.to ?? ""}|${sp.who ?? ""}|${sp.q ?? ""}|${sp.page ?? ""}|${sp.emp ?? ""}`}
      spec={spec}
      rows={rows}
      label={screen.label}
      sub={sub}
      tabs={tabs}
      initialOpen={sp.open ?? null}
      filter={filter}
      godowns={officeList.map((o) => ({ v: o.name, l: o.name }))}
    />
  );
}
