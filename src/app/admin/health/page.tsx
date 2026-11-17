import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { DERIVED_FIGURES } from "@/lib/admin-derived";
import { dataHealthChecks } from "@/lib/services/admin-console-service";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { RebuildButton } from "./rebuild-button";

/**
 * DATA HEALTH — the book's loose ends, each a count with the screen that
 * fixes it, and a rebuild button beside every derived figure.
 *
 * A derived figure is never hand-edited (AGENTS.md); when one is wrong the
 * fix is to run its recompute, which is what each button does.
 */
export default async function DataHealthPage() {
  await requirePlatformAdmin();
  const checks = await dataHealthChecks({
    sheets: ADMIN.sheets("issues"),
    catalogue: ADMIN.catalogue("duplicates"),
    customers: "/crm/customers",
  });
  const failing = checks.filter((c) => c.n > 0);
  const urgent = failing.filter((c) => c.tone === "danger").length;

  return (
    <AdminPage
      title="Data health"
      subtitle="Loose ends in the book, and the rebuild for every derived figure."
      metrics={[
        { label: "Checks passing", value: `${checks.length - failing.length} / ${checks.length}`, tone: failing.length ? undefined : "success" },
        { label: "Urgent", value: String(urgent), tone: urgent ? "danger" : undefined },
        { label: "To tidy", value: String(failing.length - urgent), tone: failing.length - urgent ? "warn" : undefined },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader title="Checks" />
          <ul className="divide-y divide-divider">
            {checks.map((c) => {
              const ok = c.n === 0;
              return (
                <li key={c.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span
                    className={
                      "h-2.5 w-2.5 flex-none rounded-full " + (ok ? "bg-success" : c.tone === "danger" ? "bg-danger" : "bg-warn")
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold text-ink">{c.label}</span>
                    {c.hint ? (
                      <span
                        title={c.hint}
                        aria-label={c.hint}
                        className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line text-[11px] font-semibold text-muted"
                      >
                        i
                      </span>
                    ) : null}
                  </span>
                  <span className="w-20 text-right text-lg font-bold text-ink tabular-nums">{c.n.toLocaleString("en-IN")}</span>
                  <span className="w-20 text-right">
                    {ok ? (
                      <Badge tone="success">OK</Badge>
                    ) : c.href ? (
                      <Link href={c.href} className="text-sm font-semibold">
                        Open
                      </Link>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Derived figures" />
          <ul className="divide-y divide-divider">
            {DERIVED_FIGURES.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                <span className="flex-1 font-semibold text-ink">{d.label}</span>
                <RebuildButton which={d.id} label={d.label} />
              </li>
            ))}
          </ul>
          <div className="border-t border-divider px-5 py-3 text-[13px] text-muted">
            Rebuilt nightly. <Link href={ADMIN.jobs}>Jobs &amp; schedules</Link>
          </div>
        </Card>
      </div>
    </AdminPage>
  );
}
