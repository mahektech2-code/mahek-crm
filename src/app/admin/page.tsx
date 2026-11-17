import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, cx } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { settingsPageFor } from "@/lib/config/settings-schemas";
import { stamp, initialsOf } from "@/lib/format";
import { attentionItems, platformHealth, usageStats } from "@/lib/services/admin-platform-service";
import { recentAdminActivity } from "@/lib/services/admin-console-service";
import { AdminPage } from "./_shell/admin-page";
import { requirePlatformAdmin } from "./_shell/context";

/**
 * Where a platform administrator starts, in the order the questions are
 * asked: how the platform stands (the figure cards), what needs an admin
 * today, every app once — and beside them the actions people come here to
 * take and what administrators did last.
 *
 * Every figure is a query; nothing here is a fixture.
 */
export default async function AdminHome() {
  await requirePlatformAdmin();
  const [attention, health, usage, activity] = await Promise.all([
    attentionItems(),
    platformHealth(),
    usageStats(),
    recentAdminActivity(6),
  ]);
  const urgent = attention.filter((a) => a.tone === "danger").length;

  return (
    <AdminPage
      title="Home"
      actions={
        <Link
          href={ADMIN.access}
          className="ui-btn ui-btn-primary inline-flex h-9 items-center rounded-control bg-brand px-4 text-sm font-semibold text-white no-underline hover:bg-brand-hover hover:no-underline"
        >
          Give somebody access
        </Link>
      }
      metrics={[
        {
          label: "Needs an admin today",
          value: String(attention.length),
          sub: urgent ? `${urgent} urgent` : "Nothing urgent",
          tone: urgent ? "danger" : attention.length ? "warn" : "success",
        },
        ...[...health.facts, ...usage.facts].slice(0, 5).map((f) => ({ label: f.label, value: f.value, sub: f.sub })),
      ]}
    >
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <CardHeader
              title="Needs an admin today"
              action={urgent ? <Badge tone="danger">{urgent} urgent</Badge> : null}
            />
            {attention.length === 0 ? (
              <EmptyState title="Nothing needs an admin" />
            ) : (
              <ul className="divide-y divide-divider">
                {attention.map((r) => (
                  <li key={r.one} className="flex items-center gap-4 px-5 py-3">
                    <span
                      className={cx(
                        "h-2.5 w-2.5 flex-none rounded-full",
                        r.tone === "danger" ? "bg-danger" : r.tone === "warn" ? "bg-warn" : "bg-line-strong",
                      )}
                    />
                    <span className="w-10 flex-none text-lg font-bold text-ink tabular-nums">{r.n}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-ink">{r.n === 1 ? r.one : r.many}</span>
                      <span className="block truncate text-[13px] text-muted" title={r.detail}>
                        {r.detail}
                      </span>
                    </span>
                    <Link
                      href={r.href}
                      className="flex-none rounded-control border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink no-underline hover:bg-page hover:no-underline"
                    >
                      {r.cta}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Apps" />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
              {health.apps.map((a) => {
                const page = settingsPageFor(a.id);
                return (
                  <div key={a.id} className="flex flex-col gap-1.5 border-r border-b border-divider px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">{a.name}</span>
                      <Badge tone={a.built ? "success" : "neutral"}>{a.built ? "Live" : "Not built"}</Badge>
                    </div>
                    <div className="flex items-center gap-3 text-[13px]">
                      <Link href={ADMIN.accessFor(a.id)}>
                        {a.granted} {a.granted === 1 ? "person" : "people"}
                      </Link>
                      {page && a.settings ? (
                        <Link href={ADMIN.settingsFor(page)} className="text-muted">
                          {a.settings} settings
                        </Link>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <CardHeader title="Quick actions" />
            <div className="grid grid-cols-2 gap-2.5 p-4">
              {QUICK.map((q) => (
                <Link
                  key={q.label}
                  href={q.href}
                  className="rounded-control border border-line px-3 py-2.5 text-sm font-semibold text-ink no-underline hover:bg-page hover:no-underline"
                >
                  {q.label}
                </Link>
              ))}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Recent admin activity" action={<Link href={ADMIN.audit("access")} className="text-sm font-semibold">Audit log</Link>} />
            {activity.length === 0 ? (
              <EmptyState title="Nothing yet" />
            ) : (
              <ul className="divide-y divide-divider">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-softer text-[11px] font-bold text-brand-deep">
                      {a.actor ? initialsOf(a.actor) : "—"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-body">
                        <b className="font-semibold text-ink">{a.actor ?? "The system"}</b> {a.says}
                        {a.entity ? <span className="text-muted"> · {a.entity}</span> : null}
                      </span>
                      <span className="block text-xs text-muted">{stamp(a.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </AdminPage>
  );
}

const QUICK = [
  { label: "Give access", href: ADMIN.access },
  { label: "Change a setting", href: ADMIN.settings },
  { label: "Run a job", href: ADMIN.jobs },
  { label: "End a session", href: ADMIN.signIns("now") },
  { label: "Check data health", href: ADMIN.health },
  { label: "Undo a change", href: ADMIN.changes },
] as const;

