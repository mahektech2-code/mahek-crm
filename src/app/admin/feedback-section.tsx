"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { FeedbackThread } from "@/components/feedback/feedback-thread";
import { stamp, stampDate } from "@/lib/format";
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
import { Card, Mono, Pill, btnClass, type Tone } from "./_shell/kit";

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

function age(at: string, now: number) {
  const h = Math.max(0, (now - Date.parse(at)) / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.floor(h / 24)}d`;
}

type Filters = { app: string; kind: string; impact: string; who: string; q: string };

export type FixContext = { fix: FixView | null; platformAdmin: boolean; connected: boolean; aiEnabled: boolean };

/** The pill a report carries in the list and its heading: how badly it bites, or what kind of thing it is. */
function tagOf(r: FeedbackRow): [Tone, string] {
  if (r.kind === "bug" || r.impact) {
    if (r.impact === "blocking") return ["danger", "Blocking"];
    if (r.impact === "slows") return ["warn", "Slows me down"];
    if (r.impact === "minor") return ["muted", "Minor"];
  }
  if (r.kind === "suggestion" || r.kind === "feature") return ["info", "Idea"];
  if (r.kind === "question") return ["muted", "Question"];
  return ["muted", KIND_SHORT[r.kind]];
}

const IMPACT_BAR: Record<FeedbackImpact | "none", string> = {
  blocking: "bg-danger",
  slows: "bg-warn",
  minor: "bg-line-strong",
  none: "bg-line-strong",
};

const QUEUE_TONE: Record<string, Tone> = { reply: "brand", waiting: "warn", looking: "info", closed: "ok", all: "muted" };

/** The queues as link tabs, the canvas's way: 22px apart, "Needs a reply" counted in red. */
export function InboxTabs({
  items,
  active,
}: {
  items: { slug: string; label: string; href: string; count: number | null }[];
  active: string;
}) {
  return (
    <nav aria-label="Queues" className="flex flex-wrap gap-x-[22px] border-b border-line">
      {items.map((t) => {
        const on = t.slug === active;
        return (
          <Link
            key={t.slug}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={cx(
              "-mb-px flex items-center gap-1.5 border-b-2 py-2.5 text-[13px] font-semibold whitespace-nowrap no-underline hover:no-underline",
              on ? "border-brand text-ink" : "border-transparent text-muted hover:text-body",
            )}
          >
            {t.label}
            {t.count ? (
              <span
                className={cx(
                  "rounded-full px-[7px] py-px text-[11px] font-semibold",
                  t.slug === "reply" ? "bg-danger text-white" : "bg-[#eef1f6] text-[#4a5670]",
                )}
              >
                {t.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** The title row's search and Filters button. Both write the URL; choosing anything closes the open report. */
export function InboxToolbar({
  filters,
  apps,
  assignees,
}: {
  filters: Filters;
  apps: string[];
  assignees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = React.useState(filters.q);
  const [open, setOpen] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const go = (patch: Partial<Filters>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    router.push(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  const on = [filters.app, filters.kind, filters.impact, filters.who].filter(Boolean).length;
  const appList = [...apps, filters.app].filter(Boolean).filter((a, i, all) => all.indexOf(a) === i);

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go({ q });
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="FB-1042, a name, a word"
          aria-label="Find a report"
          className="box-border h-9 w-[260px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink outline-none focus:border-brand"
        />
      </form>
      <div ref={box} className="relative">
        <button type="button" className={btnClass()} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {on ? `Filters · ${on}` : "Filters"}
        </button>
        {open ? (
          <div className="absolute top-[42px] right-0 z-30 flex w-[280px] flex-col gap-2.5 rounded-card border border-line bg-surface p-3.5 shadow-[0_8px_24px_rgba(15,27,51,0.12)]">
            <FilterSelect label="App" value={filters.app} onChange={(v) => go({ app: v })} options={appList.map((a) => [a, appName(a)])} />
            <FilterSelect label="Kind" value={filters.kind} onChange={(v) => go({ kind: v })} options={FEEDBACK_KINDS.map((k) => [k, KIND_SHORT[k]])} />
            <FilterSelect label="Impact" value={filters.impact} onChange={(v) => go({ impact: v })} options={FEEDBACK_IMPACTS.map((i) => [i, IMPACT_SHORT[i]])} />
            <FilterSelect
              label="Holding it"
              value={filters.who}
              onChange={(v) => go({ who: v })}
              options={[["mine-or-none", "Me + nobody"], ["me", "Me"], ["none", "Nobody"], ...assignees.map((a) => [a.id, a.name] as [string, string])]}
            />
            {on || filters.q ? (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  go({ app: "", kind: "", impact: "", who: "", q: "" });
                }}
                className="cursor-pointer self-start text-[13px] font-semibold text-brand"
              >
                Clear all
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

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

  const filtered = !!(filters.app || filters.kind || filters.impact || filters.who || filters.q);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,0.9fr)_minmax(0,1.6fr)]">
      <Card className="lg:sticky lg:top-4">
        <div className="lg:max-h-[calc(100vh-180px)] lg:overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <div className="text-sm font-semibold text-ink">
                {queue === "reply" ? "Nobody is waiting on an answer" : `Nothing in ${QUEUE_LABELS[queue]}`}
              </div>
              <div className="mt-1 text-muted">
                {filtered ? "Nothing matches these filters." : "What the team sends from the Feedback button lands here."}
              </div>
            </div>
          ) : (
            rows.map((r) => {
              const on = selected?.id === r.id;
              const [tone, tag] = tagOf(r);
              const late = r.queue === "reply" && now - Date.parse(r.lastActivityAt) > 86_400_000;
              return (
                <Link
                  key={r.id}
                  href={hrefWith({ r: r.id })}
                  scroll={false}
                  aria-current={on ? "true" : undefined}
                  className={cx(
                    "flex flex-col gap-1 border-b border-divider px-4 py-3 text-body no-underline last:border-b-0 hover:text-body hover:no-underline",
                    on ? "bg-[#f7f5ff] shadow-[inset_3px_0_0_#6835fb]" : "hover:bg-[#f7f9fc]",
                  )}
                >
                  <span className="flex items-center gap-2.5">
                    <Mono>{r.ref}</Mono>
                    <Pill tone={tone}>{tag}</Pill>
                    <span className="flex-1" />
                    <span className={cx("tabular-nums", late ? "font-semibold text-danger" : "text-muted")} title={`Last activity ${stamp(r.lastActivityAt)}`}>
                      {age(r.lastActivityAt, now)}
                    </span>
                  </span>
                  <b className="font-semibold text-ink">{r.title}</b>
                  <span className="truncate text-muted" title={r.assigneeName ? `With ${r.assigneeName}` : "Nobody is holding it"}>
                    {r.byName.split(" ")[0]} · {appName(r.app)}
                    {r.alsoReported.length ? ` · +${r.alsoReported.length}` : ""}
                  </span>
                </Link>
              );
            })
          )}
        </div>
      </Card>

      {selected ? (
        <Detail key={selected.id} row={selected} assignees={assignees} viewerId={viewerId} maxImages={maxImages} fixing={fixing} />
      ) : null}
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
    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-9 cursor-pointer rounded-control border px-2.5 text-[13px] font-medium outline-none",
          value ? "border-brand bg-brand-soft text-brand-deep" : "border-line-strong bg-surface text-ink",
        )}
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

/** A small button-shaped select: "Assign · Vikram", "Status · Being looked at". */
function PillSelect({
  label,
  shown,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  shown: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={cx(btnClass("plain", "sm"), "relative")}>
      {label} · {shown}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {children}
      </select>
    </label>
  );
}

function Detail({
  row,
  assignees,
  viewerId,
  maxImages,
  fixing,
}: {
  row: FeedbackRow;
  assignees: { id: string; name: string }[];
  viewerId: string;
  maxImages: number;
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

  const [tone, tag] = tagOf(row);
  const holder = assignees.find((a) => a.id === row.assigneeId)?.name ?? row.assigneeName ?? "Nobody";
  const also = row.alsoReported.map((a) => a.byName).join(", ");

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-2.5 border-b border-divider px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <Mono>{row.ref}</Mono>
            <Pill tone={tone}>{tag}</Pill>
            <Pill tone={QUEUE_TONE[row.queue] ?? "muted"}>{QUEUE_LABELS[row.queue]}</Pill>
            {row.verdict === "fixed" ? <Pill tone="ok">Confirmed fixed</Pill> : null}
          </div>
          <h2 className="m-0 text-[15px] font-bold text-ink">{row.title}</h2>
          <div className="text-muted" title={`Browser: ${browserOf(row.userAgent)}${also ? ` · Also reported by ${also}` : ""}`}>
            {row.byName} · {appName(row.app)}
            {row.path ? (
              <>
                {" › "}
                <a href={row.path} target="_blank" rel="noreferrer" className="font-mono text-xs">
                  {row.path} ↗
                </a>
              </>
            ) : null}{" "}
            · {stampDate(row.createdAt)}
            {row.alsoReported.length ? ` · +${row.alsoReported.length} reported it too` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <PillSelect
            label="Assign"
            shown={holder}
            value={row.assigneeId ?? ""}
            disabled={busy}
            onChange={(v) => run(() => assignFeedback(row.id, v || null))}
          >
            <option value="">Nobody</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === viewerId ? `${a.name} (me)` : a.name}
              </option>
            ))}
          </PillSelect>
          <PillSelect
            label="Status"
            shown={STATUS_LABELS[row.status]}
            value={row.status}
            disabled={busy}
            onChange={(v) => run(() => setFeedbackStatus(row.id, v as FeedbackStatus))}
          >
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </PillSelect>
          <button type="button" className={btnClass("plain", "sm")} onClick={() => setMerging((v) => !v)}>
            Merge into…
          </button>
        </div>
      </div>

      {merging ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => mergeFeedback(row.id, mergeInto));
          }}
          className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3"
        >
          <label className="text-muted" htmlFor="merge-into">
            Same problem as which report?
          </label>
          <input
            id="merge-into"
            autoFocus
            value={mergeInto}
            onChange={(e) => setMergeInto(e.target.value)}
            placeholder="FB-1038"
            className="h-[30px] w-[140px] rounded-control border border-line-strong bg-surface px-2.5 text-[13px] outline-none focus:border-brand"
          />
          <button type="submit" className={btnClass("primary", "sm")} disabled={busy || !mergeInto.trim()}>
            Merge
          </button>
          <button type="button" className={btnClass("plain", "sm")} onClick={() => setMerging(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      <FixCard
        reportId={row.id}
        reportRef={row.ref}
        fix={fixing.fix}
        platformAdmin={fixing.platformAdmin}
        connected={fixing.connected}
        aiEnabled={fixing.aiEnabled}
        extra={
          <button type="button" className={btnClass("plain", "sm")} onClick={copyBrief}>
            Copy for developer
          </button>
        }
      />

      {note ? (
        <div className={cx("border-b border-divider px-4 py-2", note.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{note.text}</div>
      ) : null}

      <div className="p-4">
        {row.verdict === "still_happening" ? (
          <div className="mb-3.5 rounded-card border border-danger bg-danger-soft px-3.5 py-2 font-medium text-danger">
            {row.byName.split(" ")[0]} says it is still happening — it was reopened.
          </div>
        ) : null}
        <FeedbackThread report={row} viewerId={viewerId} maxImages={maxImages} view="team" />
      </div>
    </Card>
  );
}

function browserOf(ua: string | null) {
  if (!ua) return "—";
  const name = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const v = ua.match(/(?:Edg|Chrome|Firefox|Version)\/(\d+)/)?.[1];
  return [name, v, os ? `· ${os}` : ""].filter(Boolean).join(" ");
}

/* --------------------------------------------------------------- overview */

export function FeedbackOverviewScreen({ overview: o }: { overview: FeedbackOverview }) {
  const max = Math.max(1, ...o.openByApp.map((a) => a.n));
  const hours = o.medianFirstReplyHours;
  return (
    <div className="flex flex-col gap-4">
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
