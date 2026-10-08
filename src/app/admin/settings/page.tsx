import Link from "next/link";
import { Card, CardHeader, EmptyState, Td, Th, Tr } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { ADMIN } from "@/lib/admin-routes";
import { schemaFields } from "@/lib/config/schema-contract";
import { schemaForPage, settingAddress } from "@/lib/config/settings-schemas";
import { stamp } from "@/lib/format";
import { configDrift } from "@/lib/services/admin-platform-service";
import { AdminPage } from "../_shell/admin-page";
import { adminContext } from "../_shell/context";

/**
 * Every settings page, and every setting that no longer matches the code's
 * default — with a link from each straight to where it is changed.
 *
 * The drift list was Overview → Configuration, a tab whose only way onward was
 * a button to "CRM settings" whatever the setting was. A database keeps what
 * it was seeded with, so a default that changes in the code reaches nobody;
 * this is where somebody finds that out, and it belongs beside the settings.
 */
export default async function AllSettings() {
  const ctx = await adminContext();
  const { rows, warnings } = await configDrift();

  const pages = ctx.settingsPages.map((p) => {
    const keys = new Set(schemaFields(schemaForPage(p.id)!).filter((f) => f.control !== "entity").map((f) => f.key));
    return { ...p, total: keys.size, changed: rows.filter((r) => keys.has(r.key)).length };
  });
  const visible = new Set(ctx.settingsPages.map((p) => p.id));
  const drift = rows
    .map((r) => ({ ...r, at: settingAddress(r.key) }))
    .filter((r) => r.at && visible.has(r.at.page));

  return (
    <AdminPage
      title="All settings"
      subtitle="Every threshold MahekOne runs on lives on one of these pages. Search for any setting by name or key from the bar at the top."
    >
      {warnings.length ? (
        <div className="mb-4 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <div className="text-sm font-medium text-warn-ink">
            {warnings.length === 1 ? "One setting contradicts another" : `${warnings.length} settings contradict each other`}
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            {warnings.map((w) => (
              <div key={w} className="text-sm leading-[21px] text-ink">
                {w}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <CardGrid min={260}>
        {pages.map((p) => (
          <Link
            key={p.id}
            href={ADMIN.settingsFor(p.id)}
            className="block rounded-[6px] border border-line bg-surface p-5 text-body no-underline shadow-[0_1px_2px_rgba(22,22,22,0.06)] hover:border-brand hover:no-underline"
          >
            <div className="text-[15px] font-semibold text-ink">{p.label}</div>
            <div className="mt-1 text-[13px] leading-[18px] text-muted">{p.blurb}</div>
            <div className="mt-3 text-[13px] text-body">
              {p.total} settings
              {p.changed ? <span className="text-[#5223E0]"> · {p.changed} changed from the default</span> : null}
            </div>
          </Link>
        ))}
      </CardGrid>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Changed from the default"
          hint="A database keeps what it was seeded with, so a default that changes in the code reaches nobody. These are the differences, and who made them."
        />
        {drift.length === 0 ? (
          <EmptyState title="Nothing has drifted" body="Every stored setting still matches the default the code ships with." />
        ) : (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>Setting</Th>
                  <Th>Where</Th>
                  <Th>In use</Th>
                  <Th>Code default</Th>
                  <Th>Changed</Th>
                </tr>
              </thead>
              <tbody>
                {drift.map((r, i) => (
                  <Tr key={r.key} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">
                      <Link href={`${ADMIN.settingsFor(r.at!.page, r.at!.tab)}#${r.key}`}>{r.label}</Link>
                    </Td>
                    <Td className="whitespace-nowrap text-muted">
                      {pages.find((p) => p.id === r.at!.page)?.label} › {r.at!.tabLabel}
                    </Td>
                    <Td className="max-w-[320px] truncate font-mono text-ink" title={r.current}>
                      {r.current}
                    </Td>
                    <Td className="max-w-[320px] truncate font-mono text-muted" title={r.fallback}>
                      {r.fallback}
                    </Td>
                    <Td className="whitespace-nowrap text-muted">
                      {r.changedAt ? stamp(r.changedAt) : "—"}
                      {r.changedBy ? ` · ${r.changedBy}` : ""}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AdminPage>
  );
}
