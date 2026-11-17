import Link from "next/link";
import { ADMIN } from "@/lib/admin-routes";
import { nowMs, stamp } from "@/lib/format";
import { attentionItems, jobHealth } from "@/lib/services/admin-platform-service";
import { recentAdminActivity } from "@/lib/services/admin-console-service";
import { appPulse, databasePing, lastSheetSync, signInsByDay } from "@/lib/services/admin-home-service";
import { olaPoolStatus } from "@/lib/services/ola-key-service";
import { whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { AdminPage } from "./_shell/admin-page";
import { Avatar, BtnLink, Card, CardHead, Dot, ListRow, Mono, Pill, btnClass, type Figure, type Tone } from "./_shell/kit";
import { requirePlatformAdmin } from "./_shell/context";
import { ExportHealthReport } from "./home-export";

/**
 * Where a platform administrator starts, drawn to the canvas's Home: the
 * health strip (what needs an admin, the database, the sheets, the jobs,
 * WhatsApp, the map keys), what needs an admin today, every app with its
 * people and who signed in today — and beside them the quick actions,
 * sign-ins over a fortnight and what administrators did last.
 *
 * Every figure is a query; nothing here is a fixture.
 */
export default async function AdminHome() {
  await requirePlatformAdmin();
  const [attention, activity, ping, sync, jobs, wa, ola, apps, signIns] = await Promise.all([
    attentionItems(),
    recentAdminActivity(4),
    databasePing(),
    lastSheetSync(),
    jobHealth(),
    whatsappServiceState(),
    olaPoolStatus().catch(() => ({ keys: [], allSpent: false })),
    appPulse(),
    signInsByDay(14),
  ]);
  const now = nowMs();
  const urgent = attention.filter((a) => a.tone === "danger").length;

  /* Jobs: each job's newest run decides whether it is standing. */
  const latest = new Map<string, boolean>();
  for (const j of jobs) if (!latest.has(j.job)) latest.set(j.job, j.ok);
  const jobsTotal = latest.size;
  const jobsFailed = [...latest.values()].filter((ok) => !ok).length;

  const live = ola.keys.filter((k) => k.state === "live").length;

  const figures: Figure[] = [
    {
      label: "Needs an admin today",
      value: String(attention.length),
      sub: attention.length ? `${urgent} urgent · ${attention.length - urgent} can wait` : "Nothing waiting",
      navy: true,
    },
    { label: "Database", dot: ping.ok ? "ok" : "danger", value: ping.ok ? "Healthy" : "Not answering", sub: `${ping.ms} ms` },
    {
      label: "Sheets",
      dot: !sync ? "muted" : !sync.ok ? "danger" : now - sync.at.getTime() > 3 * 3600_000 ? "warn" : "ok",
      value: sync ? ago(now - sync.at.getTime()) : "Never",
      sub: sync ? (sync.ok ? "Last sync" : "Last sync failed") : "No sync has run",
      href: ADMIN.sheets(),
    },
    {
      label: "Jobs",
      dot: jobsTotal === 0 ? "muted" : jobsFailed ? "warn" : "ok",
      value: jobsTotal ? `${jobsTotal - jobsFailed} / ${jobsTotal}` : "None run",
      sub: jobsFailed ? `${jobsFailed} failed` : jobsTotal ? "All ran" : "Nothing has run here",
      href: ADMIN.jobs,
    },
    { label: "WhatsApp (Wati)", dot: wa.active ? "ok" : "muted", value: wa.active ? "On" : "Off", sub: "Founder switch" },
    {
      label: "Ola key pool",
      dot: ola.keys.length === 0 ? "muted" : ola.allSpent ? "danger" : live < ola.keys.length ? "warn" : "ok",
      value: ola.keys.length ? `${live} of ${ola.keys.length} live` : "No key",
      sub: ola.keys.length ? (ola.keys.length - live ? `${ola.keys.length - live} resting` : "All live") : "Set in Integrations",
      href: ADMIN.integrations,
    },
  ];

  /* Apps: the busiest eight, then what is left on one tile. */
  const ranked = [...apps].sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
  const shown = ranked.length > 9 ? ranked.slice(0, 8) : ranked;
  const rest = ranked.slice(shown.length);

  const maxDay = Math.max(1, ...signIns.map((d) => d.n));
  const todayN = signIns.at(-1)?.n ?? 0;

  const report: Array<[string, string, string]> = [
    ...figures.map((f) => ["Health", f.label, `${String(f.value)}${f.sub ? ` — ${String(f.sub)}` : ""}`] as [string, string, string]),
    ...attention.map((a) => ["Needs an admin", a.n === 1 ? a.one : a.many, String(a.n)] as [string, string, string]),
    ...apps.map((a) => ["Apps", a.name, `${a.people} people · ${a.signedInToday} signed in today`] as [string, string, string]),
    ...signIns.map((d) => ["Sign-ins", d.day, String(d.n)] as [string, string, string]),
  ];

  return (
    <AdminPage
      title="Home"
      actions={
        <>
          <ExportHealthReport rows={report} />
          <BtnLink href={ADMIN.access} kind="primary">
            Give somebody access
          </BtnLink>
        </>
      }
      figures={figures}
    >
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHead title="Needs an admin today">{urgent ? <Pill tone="danger">{urgent} urgent</Pill> : null}</CardHead>
            {attention.length === 0 ? (
              <ListRow>
                <Dot tone="ok" />
                <b className="flex-1 font-semibold text-ink">Nothing needs an admin</b>
              </ListRow>
            ) : (
              attention.map((r) => (
                <ListRow key={r.one}>
                  <Dot tone={r.tone === "danger" ? "danger" : r.tone === "warn" ? "warn" : "muted"} />
                  <b className="min-w-0 flex-1 truncate font-semibold text-ink" title={r.detail}>
                    {r.n} {r.n === 1 ? r.one : r.many}
                  </b>
                  <Link href={r.href} className={btnClass("plain", "sm")}>
                    {r.cta}
                  </Link>
                </ListRow>
              ))
            )}
          </Card>

          <Card>
            <CardHead title="Apps" />
            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
              {shown.map((a) => {
                const pill: [Tone, string] = !a.built
                  ? ["muted", "Not built"]
                  : a.alerts
                    ? ["warn", `${a.alerts} alert${a.alerts === 1 ? "" : "s"}`]
                    : a.signedInToday
                      ? ["ok", "Live"]
                      : ["muted", "Quiet"];
                return (
                  <Link
                    key={a.id}
                    href={ADMIN.accessFor(a.id)}
                    className="flex flex-col gap-1.5 border-r border-b border-divider px-4 py-3.5 no-underline hover:bg-[#f7f9fc] hover:no-underline"
                  >
                    <div className="flex items-center gap-2.5">
                      <b className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{a.name}</b>
                      <Pill tone={pill[0]}>{pill[1]}</Pill>
                    </div>
                    <div className="text-[13px] text-muted">
                      {a.people} {a.people === 1 ? "person" : "people"} · {a.signedInToday} signed in today
                    </div>
                  </Link>
                );
              })}
              {rest.length ? (
                <Link
                  href={ADMIN.access}
                  title={rest.map((a) => a.name).join(", ")}
                  className="flex flex-col gap-1.5 border-r border-b border-divider px-4 py-3.5 no-underline hover:bg-[#f7f9fc] hover:no-underline"
                >
                  <div className="flex items-center gap-2.5">
                    <b className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">+{rest.length} more</b>
                    <Pill tone={rest.some((a) => a.alerts) ? "warn" : "ok"}>{rest.some((a) => a.alerts) ? "Alert" : "Live"}</Pill>
                  </div>
                  <div className="truncate text-[13px] text-muted">{rest.reduce((n, a) => n + a.people, 0)} people</div>
                </Link>
              ) : null}
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHead title="Quick actions" />
            <div className="grid grid-cols-2 gap-2.5 px-4 py-3.5">
              {QUICK.map((q) => (
                <Link
                  key={q.label}
                  href={q.href}
                  className="flex items-center gap-2.5 rounded-control border border-line px-3 py-2.5 text-[13px] font-semibold text-ink no-underline hover:bg-[#f7f9fc] hover:no-underline"
                >
                  {q.label}
                </Link>
              ))}
            </div>
          </Card>

          <Card>
            <CardHead title="Sign-ins, last 14 days" />
            <div
              className="flex h-[120px] items-end gap-1.5 p-4"
              role="img"
              aria-label={`People signing in each day for the last 14 days: ${signIns.map((d) => d.n).join(", ")}. Today ${todayN}.`}
            >
              {signIns.map((d, i) => (
                <div
                  key={d.day}
                  title={`${d.day}: ${d.n}`}
                  className="flex-1 rounded-t-[3px]"
                  style={{
                    height: `${Math.max(4, Math.round((d.n / maxDay) * 100))}%`,
                    background: i === signIns.length - 1 ? "#6835fb" : d.sunday ? "#dce3ee" : "#dcd1fc",
                  }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2.5 px-4 pb-3.5">
              <span className="text-muted">Today so far</span>
              <b className="text-ink">{todayN}</b>
            </div>
          </Card>

          <Card>
            <CardHead
              title="Recent admin activity"
              actions={
                <Link href={ADMIN.audit("access")} className="text-[13px] no-underline">
                  Audit log
                </Link>
              }
            />
            {activity.length === 0 ? (
              <ListRow>
                <span className="text-muted">No administrator has changed access or a setting yet.</span>
              </ListRow>
            ) : (
              activity.map((a) => (
                <ListRow key={a.id}>
                  <Avatar name={a.actor ?? "System"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <b className="font-semibold text-ink">{a.actor ?? "The system"}</b> {a.says}
                      {a.entity ? <> {/^[a-z][\w]*(\.[\w]+)+$/i.test(a.entity) ? <Mono>{a.entity}</Mono> : a.entity}</> : null}
                    </div>
                    <div className="text-muted">{stamp(a.at)}</div>
                  </div>
                </ListRow>
              ))
            )}
          </Card>
        </div>
      </div>
    </AdminPage>
  );
}

/** "6 min ago", "3 h ago", "2 days ago". */
function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "Just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const QUICK = [
  { label: "Give access", href: ADMIN.access },
  { label: "Reset a password", href: ADMIN.access },
  { label: "Run a job", href: ADMIN.jobs },
  { label: "Change a setting", href: ADMIN.settings },
  { label: "End a session", href: ADMIN.signIns("now") },
  { label: "Release an APK", href: ADMIN.releases },
] as const;
