"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { FeedbackThread } from "@/components/feedback/feedback-thread";
import { stamp } from "@/lib/format";
import { APPS } from "@/lib/apps";
import {
  FEEDBACK_IMPACTS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  IMPACT_SHORT,
  KIND_SHORT,
  QUEUE_LABELS,
  STATUS_LABELS,
  type FeedbackImpact,
  type FeedbackStatus,
  type TriageQueue,
} from "@/lib/feedback-labels";
import type { FeedbackOverview, FeedbackRow } from "@/lib/services/feedback-service";
import { assignFeedback, mergeFeedback, setFeedbackStatus } from "@/lib/actions/feedback";
import { ADMIN } from "@/lib/admin-routes";
import type { FixView } from "@/lib/services/feedback-fix-service";
import { FixCard } from "./feedback-fix-card";

/* ---------------------------------------------------------------------------
 * Feedback → the triage inbox.
 *
 * A section rather than a settings tab, because none of it is configuration:
 * these are rows written by colleagues, and the work here is answering them.
 *
 * The tabs are QUEUES, worked in order — Needs a reply first, because somebody
 * waiting on an answer is the only state that costs anything. Inside a queue
 * the list is worst first: can't-work before slows-down, then whoever has
 * waited longest. One report at a time is open on the right, with everything
 * needed to answer it: the conversation (team notes included), everybody who
 * reported the same thing, where it happened, who is holding it, and its
 * status. Filters and the open report ride in the URL.
 * ------------------------------------------------------------------------- */

const APP_NAME = new Map<string, string>([...APPS.map((a) => [a.id, a.name] as [string, string]), ["launcher", "Launcher"]]);
const appName = (id: string | null) => (id ? (APP_NAME.get(id) ?? id) : "—");

const IMPACT_BAR: Record<FeedbackImpact | "none", string> = {
  blocking: "bg-danger",
  slows: "bg-warn",
  minor: "bg-line-strong",
  none: "bg-line-strong",
};

function age(at: string, now: number) {
  const h = Math.max(0, (now - Date.parse(at)) / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.floor(h / 24)}d`;
}

type Filters = { app: string; kind: string; impact: string; who: string; q: string };

export type FixContext = { fix: FixView | null; platformAdmin: boolean; connected: boolean; aiEnabled: boolean };

export function FeedbackSection({
  rows,
  selected,
  filters,
  assignees,
  viewerId,
  maxImages,
  queue,
  now,
  fixing,
}: {
  /** The server's clock, read once — a component may not read it in render. */
  now: number;
  /** The open report's "Fix it" state, and who is looking. */
  fixing: FixContext;
  rows: FeedbackRow[];
  selected: FeedbackRow | null;
  filters: Filters;
  assignees: { id: string; name: string }[];
  viewerId: string;
  maxImages: number;
  queue: TriageQueue;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = React.useState(filters.q);

  const hrefWith = React.useCallback(
    (patch: Partial<Filters & { r: string }>) => {
      const p = new URLSearchParams();
      const next = { ...filters, r: selected?.id ?? "", ...patch };
      for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
      const s = p.toString();
      return s ? `${pathname}?${s}` : pathname;
    },
    [filters, pathname, selected],
  );
  // Pin the open report in the address the first time one is shown, so an
  // answer that moves it to another queue does not take it off the screen.
  const selectedId = selected?.id ?? null;
  const pinned = React.useRef(false);
  React.useEffect(() => {
    if (!selectedId || pinned.current) return;
    pinned.current = true;
    if (!new URLSearchParams(window.location.search).get("r")) {
      router.replace(hrefWith({ r: selectedId }), { scroll: false });
    }
  }, [selectedId, router, hrefWith]);
  const setFilter = (patch: Partial<Filters>) => router.push(hrefWith({ ...patch, r: "" }), { scroll: false });

  const apps = [...new Set(rows.map((r) => r.app).filter((a): a is string => !!a)), filters.app]
    .filter(Boolean)
    .filter((a, i, all) => all.indexOf(a) === i);

  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ q });
          }}
          className="flex h-9 min-w-[240px] flex-1 items-center gap-2 rounded-[7px] border border-line bg-surface px-2.5 sm:max-w-[340px]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none text-muted" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search words, FB-number or person"
            aria-label="Search feedback"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
        </form>
        <FilterSelect label="App" value={filters.app} onChange={(v) => setFilter({ app: v })}
          options={apps.map((a) => [a, appName(a)])} />
        <FilterSelect label="Kind" value={filters.kind} onChange={(v) => setFilter({ kind: v })}
          options={FEEDBACK_KINDS.map((k) => [k, KIND_SHORT[k]])} />
        <FilterSelect label="Impact" value={filters.impact} onChange={(v) => setFilter({ impact: v })}
          options={FEEDBACK_IMPACTS.map((i) => [i, IMPACT_SHORT[i]])} />
        <FilterSelect label="Holding it" value={filters.who} onChange={(v) => setFilter({ who: v })}
          options={[["mine-or-none", "Me + nobody"], ["me", "Me"], ["none", "Nobody"], ...assignees.map((a) => [a.id, a.name] as [string, string])]} />
        {filters.app || filters.kind || filters.impact || filters.who || filters.q ? (
          <button type="button" onClick={() => { setQ(""); setFilter({ app: "", kind: "", impact: "", who: "", q: "" }); }}
            className="cursor-pointer text-[13px] font-medium text-brand">
            Clear
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <section className="min-w-0 flex-[1_1_320px] overflow-hidden rounded-[8px] border border-line bg-surface xl:max-w-[400px]">
          {rows.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <div className="text-sm font-semibold text-ink">
                {queue === "reply" ? "Nobody is waiting on an answer" : `Nothing in ${QUEUE_LABELS[queue]}`}
              </div>
              <div className="mt-1 text-[13px] text-muted">
                {filters.app || filters.kind || filters.impact || filters.who || filters.q
                  ? "Nothing matches these filters."
                  : "The Feedback button sits in the header of every app; what the team sends lands here."}
              </div>
            </div>
          ) : (
            rows.map((r) => (
              <Link
                key={r.id}
                href={hrefWith({ r: r.id })}
                scroll={false}
                aria-current={selected?.id === r.id ? "true" : undefined}
                className={cx(
                  "flex gap-2.5 border-b border-divider px-3.5 py-3 no-underline hover:no-underline",
                  selected?.id === r.id ? "bg-brand-soft" : "hover:bg-page",
                )}
              >
                <span className={cx("w-1 flex-none rounded-full", IMPACT_BAR[r.impact ?? "none"])} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start gap-2">
                    <span className={cx("min-w-0 flex-1 text-sm leading-[19px] text-ink", r.queue === "reply" ? "font-semibold" : "font-medium")}>
                      {r.title}
                    </span>
                    <span
                      className={cx(
                        "flex-none text-xs tabular-nums",
                        r.queue === "reply" && now - Date.parse(r.lastActivityAt) > 86_400_000
                          ? "font-semibold text-danger"
                          : r.queue === "reply"
                            ? "font-semibold text-warn-ink"
                            : "text-muted",
                      )}
                      title={`Last activity ${stamp(r.lastActivityAt)}`}
                    >
                      {age(r.lastActivityAt, now)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {r.ref} · {r.byName} · {appName(r.app)}
                    {r.alsoReported.length ? ` · ${1 + r.alsoReported.length} people` : ""}
                    {r.kind !== "bug" ? ` · ${KIND_SHORT[r.kind]}` : ""}
                  </span>
                  {r.assigneeName ? <span className="mt-0.5 block text-[11px] text-faint">With {r.assigneeName}</span> : null}
                </span>
              </Link>
            ))
          )}
          <div className="px-3.5 py-2.5 text-[11px] leading-4 text-muted">
            Red bar: can&apos;t work. Amber: slows them down. Age turns red past a day without an answer.
          </div>
        </section>

        {selected ? (
          <Detail key={selected.id} row={selected} assignees={assignees} viewerId={viewerId} maxImages={maxImages} now={now} fixing={fixing} />
        ) : null}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label
      className={cx(
        "flex h-9 items-center gap-1 rounded-[7px] border pr-1 pl-2.5 text-[13px]",
        value ? "border-brand bg-brand-soft text-brand-deep" : "border-line bg-surface text-body",
      )}
    >
      <span className="font-medium whitespace-nowrap">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer bg-transparent py-1 pr-1 font-medium outline-none"
      >
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function Detail({
  row,
  assignees,
  viewerId,
  maxImages,
  now,
  fixing,
}: {
  row: FeedbackRow;
  assignees: { id: string; name: string }[];
  viewerId: string;
  maxImages: number;
  now: number;
  fixing: FixContext;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [merging, setMerging] = React.useState(false);
  const [mergeInto, setMergeInto] = React.useState("");

  async function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setBusy(true);
    setNote(null);
    const r = await fn();
    setBusy(false);
    setNote(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error ?? "That did not work." });
    if (r.ok) router.refresh();
  }

  const waited = row.queue === "reply" ? age(row.lastActivityAt, now) : null;

  async function copyBrief() {
    const lines = [
      `${row.ref} — ${row.title}`,
      `${KIND_SHORT[row.kind]}${row.impact ? ` · ${IMPACT_SHORT[row.impact]}` : ""} · ${appName(row.app)} · ${row.path ?? "no screen"}`,
      `Reported by ${row.byName} on ${stamp(row.createdAt)}${row.alsoReported.length ? ` (+${row.alsoReported.length} more)` : ""}`,
      `Browser: ${row.userAgent ?? "not recorded"}`,
      "",
      row.body,
      ...row.alsoReported.map((a) => `\n${a.byName}: ${a.body}`),
      ...row.messages.filter((m) => m.body).map((m) => `\n${m.internal ? "[team note] " : ""}${m.authorName}: ${m.body}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setNote({ ok: true, text: "Copied — paste it into the issue or a message to the developer." });
    } catch {
      setNote({ ok: false, text: "The browser would not copy it." });
    }
  }

  return (
    <section className="min-w-0 flex-[999_1_560px] overflow-hidden rounded-[8px] border border-line bg-surface">
      <div className="flex flex-wrap items-start gap-2 border-b border-divider px-4.5 py-3.5">
        <div className="min-w-[260px] flex-1">
          <div className="text-xs text-muted">
            {row.ref} · {KIND_SHORT[row.kind]}
            {row.impact ? (
              <>
                {" · "}
                <span className={cx("font-semibold", row.impact === "blocking" ? "text-danger" : row.impact === "slows" ? "text-warn-ink" : "")}>
                  {IMPACT_SHORT[row.impact]}
                </span>
              </>
            ) : null}
            {waited ? ` · waiting ${waited}` : ""}
          </div>
          <h2 className="mt-0.5 text-lg leading-6 font-bold text-ink">{row.title}</h2>
        </div>
        <label className="flex h-8 items-center gap-1 rounded-[7px] border border-line bg-surface pl-2.5 text-[13px]">
          <span className="text-muted">Holding it:</span>
          <select
            value={row.assigneeId ?? ""}
            disabled={busy}
            onChange={(e) => run(() => assignFeedback(row.id, e.target.value || null))}
            className="cursor-pointer bg-transparent py-1 pr-1 font-medium text-ink outline-none"
          >
            <option value="">Nobody</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === viewerId ? `${a.name} (me)` : a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-8 items-center gap-1 rounded-[7px] border border-line bg-surface pl-2.5 text-[13px]">
          <span className="text-muted">Status:</span>
          <select
            value={row.status}
            disabled={busy}
            onChange={(e) => run(() => setFeedbackStatus(row.id, e.target.value as FeedbackStatus))}
            className="cursor-pointer bg-transparent py-1 pr-1 font-medium text-ink outline-none"
          >
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {note ? (
        <div className={cx("border-b border-divider px-4.5 py-2 text-[13px]", note.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
          {note.text}
        </div>
      ) : null}

      <div className="flex flex-wrap">
        <div className="min-w-0 flex-[999_1_360px] px-4.5 py-4">
          {row.verdict === "still_happening" ? (
            <div className="mb-3 rounded-[8px] border border-danger bg-danger-soft px-3.5 py-2 text-[13px] font-medium text-danger">
              {row.byName.split(" ")[0]} says it is still happening — it was reopened.
            </div>
          ) : null}
          <FeedbackThread report={row} viewerId={viewerId} maxImages={maxImages} view="team" />
        </div>

        <aside className="min-w-0 flex-[1_1_220px] border-l border-divider bg-page px-4 py-4">
          <SideTitle>Where it happened</SideTitle>
          <Fact k="App">{appName(row.app)}</Fact>
          <Fact k="Screen">
            {row.path ? (
              <a href={row.path} target="_blank" rel="noreferrer" className="font-mono text-[11px] break-all">
                {row.path} ↗
              </a>
            ) : (
              "—"
            )}
          </Fact>
          <Fact k="Browser">{browserOf(row.userAgent)}</Fact>
          <Fact k="Sent">{stamp(row.createdAt)}</Fact>
          <div className="my-3 h-px bg-divider" />
          <SideTitle>Who sent it</SideTitle>
          <Fact k="Person">{row.byName}</Fact>
          {row.alsoReported.length ? (
            <Fact k="Also">{row.alsoReported.map((a) => a.byName).join(", ")}</Fact>
          ) : null}
          {row.verdict === "fixed" ? <Fact k="Answer">Confirmed fixed</Fact> : null}
          <div className="my-3 h-px bg-divider" />
          <FixCard
            reportId={row.id}
            reportRef={row.ref}
            fix={fixing.fix}
            platformAdmin={fixing.platformAdmin}
            connected={fixing.connected}
            aiEnabled={fixing.aiEnabled}
          />
          <div className="my-3 h-px bg-divider" />
          <div className="flex flex-col gap-1.5">
            {merging ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(() => mergeFeedback(row.id, mergeInto));
                }}
                className="flex flex-col gap-1.5"
              >
                <label className="text-xs text-body" htmlFor="merge-into">
                  Same problem as which report?
                </label>
                <input
                  id="merge-into"
                  autoFocus
                  value={mergeInto}
                  onChange={(e) => setMergeInto(e.target.value)}
                  placeholder="FB-1038"
                  className="h-8 rounded-[7px] border border-line-strong bg-surface px-2.5 text-[13px] outline-none focus:border-brand"
                />
                <div className="flex gap-1.5">
                  <Button size="sm" variant="primary" disabled={busy || !mergeInto.trim()} className="flex-1">
                    Merge
                  </Button>
                  <Button size="sm" variant="secondary" type="button" onClick={() => setMerging(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setMerging(true)}>
                Merge into another…
              </Button>
            )}
            {row.path ? (
              <a
                href={row.path}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center justify-center rounded-[7px] border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Open the screen
              </a>
            ) : null}
            <Button size="sm" variant="secondary" onClick={copyBrief}>
              Copy for developer
            </Button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function browserOf(ua: string | null) {
  if (!ua) return "—";
  const name = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const v = ua.match(/(?:Edg|Chrome|Firefox|Version)\/(\d+)/)?.[1];
  return [name, v, os ? `· ${os}` : ""].filter(Boolean).join(" ");
}

function SideTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold text-ink">{children}</div>;
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1 text-xs text-body">
      <span className="w-14 flex-none text-muted">{k}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/* --------------------------------------------------------------- overview */

export function FeedbackOverviewScreen({ overview: o }: { overview: FeedbackOverview }) {
  const max = Math.max(1, ...o.openByApp.map((a) => a.n));
  const hours = o.medianFirstReplyHours;
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex justify-end">
        <div className="flex overflow-hidden rounded-[7px] border border-line bg-surface text-xs font-medium">
          {[30, 90].map((d) => (
            <Link
              key={d}
              href={`${ADMIN.feedback("overview")}${d === 90 ? "?p=90" : ""}`}
              className={cx(
                "px-3 py-1.5 no-underline hover:no-underline",
                o.periodDays === d ? "bg-brand-soft font-semibold text-brand-deep" : "text-body",
              )}
            >
              Last {d} days
            </Link>
          ))}
        </div>
      </div>

      <CardGrid min={200} gap="gap-3">
        <Figure
          label="Needs a first reply"
          value={String(o.needsFirstReply)}
          sub={o.firstReplyOverdue ? `${o.firstReplyOverdue} waiting more than a day` : "none waiting more than a day"}
          href={ADMIN.feedback("reply")}
          alarm={o.firstReplyOverdue > 0}
        />
        <Figure label="Open" value={String(o.open)} sub={`${o.beingLookedAt} being looked at`} />
        <Figure
          label="Time to first reply"
          value={hours === null ? "—" : hours < 1 ? `${Math.round(hours * 60)} min` : `${Math.round(hours)} h`}
          sub="median, from the report to the team's first line"
        />
        <Figure
          label="Confirmed fixed by the reporter"
          value={String(o.confirmedFixed)}
          sub={o.stillHappening ? `${o.stillHappening} said “still happening”` : "nobody said “still happening”"}
        />
      </CardGrid>

      <div className="flex flex-wrap gap-4">
        <section className="min-w-0 flex-[1_1_360px] rounded-[8px] border border-line bg-surface px-4.5 py-4">
          <h2 className="mb-2 text-[15px] font-semibold text-ink">Open, by app</h2>
          {o.openByApp.length ? (
            o.openByApp.map((a) => (
              <Link key={a.app} href={`${ADMIN.feedback("all")}?app=${a.app}`} className="flex items-center gap-2.5 py-1.5 text-[13px] text-body no-underline hover:no-underline">
                <span className="w-[130px] flex-none truncate">{appName(a.app)}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-brand-soft">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${(a.n / max) * 100}%` }} />
                </span>
                <span className="w-7 text-right font-semibold tabular-nums">{a.n}</span>
              </Link>
            ))
          ) : (
            <div className="text-[13px] text-muted">Nothing open.</div>
          )}
        </section>
        <section className="min-w-0 flex-[1_1_360px] rounded-[8px] border border-line bg-surface px-4.5 py-4">
          <h2 className="mb-1 text-[15px] font-semibold text-ink">Screens reported most</h2>
          {o.topScreens.length ? (
            o.topScreens.map((s) => (
              <div key={s.path} className="flex items-center gap-2.5 border-b border-divider py-2 text-[13px] last:border-0">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{s.path}</span>
                <span className="flex-none text-muted">
                  {s.reports} report{s.reports === 1 ? "" : "s"}
                  {s.issues !== s.reports ? ` · ${s.issues} issue${s.issues === 1 ? "" : "s"}` : ""}
                </span>
              </div>
            ))
          ) : (
            <div className="text-[13px] text-muted">Nothing reported in this period.</div>
          )}
        </section>
      </div>

      <section className="rounded-[8px] border border-line bg-surface px-4.5 py-4">
        <h2 className="mb-1 text-[15px] font-semibold text-ink">Waiting longest without a reply</h2>
        {o.waitingLongest.length ? (
          o.waitingLongest.map((r) => (
            <Link
              key={r.id}
              href={`${ADMIN.feedback("reply")}?r=${r.id}`}
              className="flex items-center gap-2.5 border-b border-divider py-2.5 text-[13px] text-ink no-underline last:border-0 hover:no-underline"
            >
              <span className={cx("h-7 w-1 flex-none rounded-full", IMPACT_BAR[r.impact ?? "none"])} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{r.title}</span>
                <span className="block text-xs text-muted">
                  {r.ref} · {r.byName}
                  {r.alsoReported.length ? ` + ${r.alsoReported.length}` : ""} · {appName(r.app)}
                </span>
              </span>
              <span className="flex-none text-xs text-muted">since {stamp(r.lastActivityAt)}</span>
            </Link>
          ))
        ) : (
          <div className="text-[13px] text-muted">Nobody is waiting on an answer.</div>
        )}
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  href,
  alarm,
}: {
  label: string;
  value: string;
  sub: string;
  href?: string;
  alarm?: boolean;
}) {
  const body = (
    <>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cx("mt-1.5 text-[28px] leading-8 font-semibold", alarm ? "text-danger" : "text-ink")}>{value}</div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </>
  );
  const cls = cx("rounded-[8px] border bg-surface px-4.5 py-4", alarm ? "border-danger" : "border-line");
  return href ? (
    <Link href={href} className={cx(cls, "no-underline hover:no-underline")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
