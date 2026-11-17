import Link from "next/link";
import { ADMIN } from "@/lib/admin-routes";
import { calendarDate } from "@/lib/business-date";
import { DERIVED_FIGURES } from "@/lib/admin-derived";
import { clock, nowMs, shortDate } from "@/lib/format";
import { dataHealthChecks } from "@/lib/services/admin-console-service";
import { derivedLastRebuilt, extraHealthChecks } from "@/lib/services/admin-data-view-service";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { Card, btnClass } from "../_shell/kit";
import { CheckNowButton, RebuildAllButton, RebuildButton } from "./rebuild-button";

/**
 * DATA HEALTH — the book's loose ends, each a count with the screen that
 * fixes it, and a rebuild button beside every derived figure.
 *
 * A derived figure is never hand-edited (AGENTS.md); when one is wrong the
 * fix is to run its recompute, which is what each button does. "When it was
 * last rebuilt" is the newer of the last clean nightly pass and the last
 * Rebuild pressed for it — both recorded; nothing else is.
 */
const DAY = 24 * 60 * 60 * 1000;

export default async function DataHealthPage() {
  await requirePlatformAdmin();
  const [base, extra, rebuilt] = await Promise.all([
    dataHealthChecks({
      sheets: ADMIN.sheets(),
      catalogue: ADMIN.catalogue("duplicates"),
      customers: "/crm/customers",
    }),
    extraHealthChecks(),
    derivedLastRebuilt(DERIVED_FIGURES.map((d) => d.id)),
  ]);
  const checks = [...base, ...extra];
  const now = nowMs();
  const failing = checks.filter((c) => c.n > 0);
  const urgent = failing.filter((c) => c.tone === "danger").length;
  const stale = DERIVED_FIGURES.filter((d) => !rebuilt[d.id] || now - Date.parse(rebuilt[d.id]!) > DAY).length;
  /* Trouble first, the passing checks after — the order the canvas reads in. */
  const ordered = [...checks].sort((a, b) => rank(a) - rank(b));
  const today = calendarDate(new Date(now));
  const when = (iso: string | null) => {
    if (!iso) return "Never";
    const d = new Date(iso);
    return calendarDate(d) === today ? `${clock(d)} today` : shortDate(d);
  };

  return (
    <AdminPage
      title="Data health"
      actions={
        <>
          <span className="text-sm text-muted">Checked {clock(new Date(now))}</span>
          <CheckNowButton />
        </>
      }
      figures={[
        { label: "Checks passing", value: `${checks.length - failing.length} / ${checks.length}`, navy: true },
        { label: "Urgent", value: String(urgent), tone: urgent ? "danger" : undefined },
        { label: "To tidy", value: String(failing.length - urgent), tone: failing.length - urgent ? "warn" : undefined },
        { label: "Caches older than a day", value: String(stale), tone: stale ? "warn" : undefined },
      ]}
    >
      <div className="grid items-start gap-[18px]" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(320px,1fr)" }}>
        <Card>
          <Head title="Checks" />
          {ordered.map((c) => {
            const ok = c.n === 0;
            return (
              <div
                key={c.id}
                className="grid items-center gap-3.5 border-b border-divider px-[18px] py-3.5 text-sm last:border-b-0"
                style={{ gridTemplateColumns: "12px minmax(0,1fr) 110px 110px" }}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${ok ? "bg-success" : c.tone === "danger" ? "bg-danger" : "bg-warn"}`} />
                <span className="flex min-w-0 items-center gap-1.5">
                  <b className="font-semibold text-ink">{c.label}</b>
                  {c.hint && !ok ? (
                    <span
                      title={c.hint}
                      aria-label={c.hint}
                      className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted"
                    >
                      i
                    </span>
                  ) : null}
                </span>
                <span className="text-right text-lg font-bold text-ink tabular-nums">{c.n.toLocaleString("en-IN")}</span>
                <span>
                  {ok ? (
                    <span className="flex h-[22px] items-center rounded-full bg-success-soft px-2 text-xs font-semibold text-success">OK</span>
                  ) : c.href ? (
                    <Link href={c.href} className={`${btnClass("plain", "sm")} h-8 w-full`}>
                      Open
                    </Link>
                  ) : (
                    <span className="text-xs text-muted" title="No screen fixes this one by hand yet — the nightly pass places shops it can match">
                      Nightly
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </Card>

        <Card>
          <Head title="Derived figures" actions={<RebuildAllButton />} />
          {DERIVED_FIGURES.map((d) => (
            <div
              key={d.id}
              className="grid items-center gap-3 border-b border-divider px-[18px] py-3 text-sm last:border-b-0"
              style={{ gridTemplateColumns: "minmax(0,1fr) 120px 40px" }}
            >
              <b className="font-semibold text-ink">{d.label}</b>
              <span className="text-muted">{when(rebuilt[d.id])}</span>
              <RebuildButton which={d.id} label={d.label} />
            </div>
          ))}
        </Card>
      </div>
    </AdminPage>
  );
}

/** The canvas's card head: 14px by 18px, a 16px title. */
function Head({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-divider px-[18px] py-3.5">
      <h2 className="m-0 text-base font-bold text-ink">{title}</h2>
      <span className="flex-1" />
      {actions}
    </div>
  );
}

function rank(c: { n: number; tone: "danger" | "warn" }) {
  return c.n === 0 ? 2 : c.tone === "danger" ? 0 : 1;
}
