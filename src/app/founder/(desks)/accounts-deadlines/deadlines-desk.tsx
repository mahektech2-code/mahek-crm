"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Textarea, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { CardGrid } from "@/components/ui/card-grid";
import { acknowledgeDeadline, nudgeAccounts } from "@/lib/actions/accounts-sla";
import type { DeadlineBreach, DeadlinesOverview } from "@/lib/services/accounts-sla-service";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * Command Centre → Accounts deadlines.
 *
 * Open first, oldest deadline at the top, each with the accounts desk's own
 * words and when they said they would look again; the founder can mark it
 * seen or send the desk a note, and neither takes it off the desk. Below,
 * what was decided late in the last thirty days.
 * ------------------------------------------------------------------------- */

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );

type Filter = "all" | "silent" | "explained";

export function DeadlinesDesk({
  overview,
  canAct,
  settingsHref,
  nowMs,
}: {
  overview: DeadlinesOverview;
  canAct: boolean;
  settingsHref: string | null;
  nowMs: number;
}) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [tab, setTab] = React.useState<"open" | "late">("open");
  const silent = overview.open.filter((o) => o.owesReason);
  const shown = filter === "silent" ? silent : filter === "explained" ? overview.open.filter((o) => !o.owesReason) : overview.open;
  const clockWords = overview.clock === "office_hours" ? "office hours" : "hours of working days";

  return (
    <div className="w-full max-w-[1280px]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Command Centre · Operate</div>
          <h1 className="mt-0.5 text-[26px] leading-8 font-semibold text-ink">Accounts deadlines</h1>
          <p className="mt-1 text-sm text-muted">
            Anything the accounts desk has not decided within {overview.hours} {clockWords}. It stays with accounts until they decide
            it; you are told when it goes past, and again every further block of hours.
          </p>
        </div>
        {settingsHref ? (
          <a href={settingsHref} className="text-sm font-medium text-brand hover:underline">
            Change the deadline →
          </a>
        ) : null}
      </div>

      {!overview.enabled ? (
        <div className="mt-4 rounded-[6px] border border-warn bg-warn-soft px-4 py-3 text-sm text-warn-ink">
          The deadline is switched off in settings — nothing new is being reported.
        </div>
      ) : null}

      <CardGrid min={200} gap="gap-3" className="mt-5">
        <Stat label="Past the deadline now" value={overview.open.length} tone={overview.open.length ? "danger" : "success"} />
        <Stat label="With no current reason" value={silent.length} tone={silent.length ? "danger" : "muted"} note="Never answered, or the reminder came round" />
        <Stat
          label={`Decided late · last ${overview.windowDays} days`}
          value={overview.resolved.length}
          tone={overview.resolved.length ? "warn" : "muted"}
        />
        {overview.byKind
          .filter((k) => k.open)
          .map((k) => (
            <Stat key={k.kind} label={k.label} value={k.open} tone="neutral" note="open past the deadline" />
          ))}
      </CardGrid>

      <div className="mt-6 flex items-center gap-1 border-b border-divider">
        {(
          [
            ["open", `Open (${overview.open.length})`],
            ["late", `Decided late (${overview.resolved.length})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cx(
              "-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-medium",
              tab === k ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "open" ? (
        <>
          <div className="mt-3 flex gap-2">
            {(
              [
                ["all", "All"],
                ["silent", "No current reason"],
                ["explained", "Explained"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={cx(
                  "cursor-pointer rounded-full border px-3 py-1 text-sm",
                  filter === k ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-body hover:bg-canvas",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <div className="mt-6 rounded-[6px] border border-line bg-surface px-5 py-10 text-center text-sm text-muted">
              {overview.open.length === 0 ? "Nothing is past the deadline. The accounts desk is on time." : "Nothing in this filter."}
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {shown.map((b) => (
                <BreachCard key={b.breachId} b={b} canAct={canAct} nowMs={nowMs} />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="mt-3 overflow-hidden rounded-[6px] border border-line bg-surface">
          {overview.resolved.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted">Nothing was decided late in the last {overview.windowDays} days.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-left text-xs text-muted uppercase">
                  <th className="px-4 py-2 font-medium">What</th>
                  <th className="px-4 py-2 font-medium">Waiting since</th>
                  <th className="px-4 py-2 font-medium">Deadline</th>
                  <th className="px-4 py-2 font-medium">Decided</th>
                  <th className="px-4 py-2 font-medium">Late by</th>
                  <th className="px-4 py-2 font-medium">Reasons given</th>
                </tr>
              </thead>
              <tbody>
                {overview.resolved.map((r) => (
                  <tr key={r.id} className="border-b border-divider last:border-0">
                    <td className="px-4 py-2 text-ink">{r.description}</td>
                    <td className="px-4 py-2 text-muted">{fmt(r.waitingSince)}</td>
                    <td className="px-4 py-2 text-muted">{fmt(r.dueAt)}</td>
                    <td className="px-4 py-2 text-muted">{fmt(r.resolvedAt)}</td>
                    <td className="px-4 py-2">
                      <Badge tone="warn">{r.lateLabel}</Badge>
                    </td>
                    <td className="px-4 py-2 text-muted">{r.remarks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, note }: { label: string; value: number; tone: "danger" | "warn" | "success" | "muted" | "neutral"; note?: string }) {
  const color = { danger: "text-danger", warn: "text-warn-ink", success: "text-success", muted: "text-ink", neutral: "text-ink" }[tone];
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold", color)}>{value}</div>
      {note ? <div className="mt-0.5 text-xs text-muted">{note}</div> : null}
    </div>
  );
}

function BreachCard({ b, canAct, nowMs }: { b: DeadlineBreach; canAct: boolean; nowMs: number }) {
  const router = useRouter();
  const toast = useToast();
  const [nudging, setNudging] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const remarks = showAll ? b.remarks : b.remarks.slice(0, 2);
  const remindPassed = b.remindAt ? Date.parse(b.remindAt) <= nowMs : false;

  async function act(p: Promise<{ ok: boolean; message?: string; error?: string }>) {
    setBusy(true);
    const r = await toast.run(p);
    setBusy(false);
    if (r.ok) {
      setNudging(false);
      setNote("");
      router.refresh();
    }
  }

  return (
    <div className={cx("rounded-[6px] border bg-surface p-4", b.owesReason ? "border-danger" : "border-line")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="danger">{b.kindLabel}</Badge>
            <span className="text-xs text-muted">
              waiting since {fmt(b.waitingSince)} · deadline {fmt(b.dueAt)} · <b className="text-ink">{b.waitedLabel}</b> of working time
            </span>
            {b.escalations > 0 ? <Badge tone="warn">Told you {b.escalations + 1}×</Badge> : null}
            {b.acknowledged ? <Badge tone="muted">Seen by {b.acknowledged.by}</Badge> : null}
          </div>
          <div className="mt-1 text-base font-medium text-ink">{b.description.split(" · ").slice(1).join(" · ") || b.description}</div>
        </div>
        {canAct ? (
          <div className="flex shrink-0 gap-2">
            {!b.acknowledged ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(acknowledgeDeadline(b.breachId))}>
                Mark seen
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setNudging((v) => !v)}>
              Nudge accounts
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-3 rounded-[4px] bg-canvas px-3 py-2 text-sm">
        {b.lastRemark ? (
          <>
            <div className="text-ink">“{b.lastRemark.body}”</div>
            <div className="mt-0.5 text-xs text-muted">
              {b.lastRemark.by}, {fmt(b.lastRemark.at)}
              {b.lastRemark.remindAt ? (
                <>
                  {" "}
                  · {remindPassed ? <span className="font-medium text-danger">said they would look again {fmt(b.lastRemark.remindAt)} — that has passed</span> : `will look again ${fmt(b.lastRemark.remindAt)}`}
                </>
              ) : null}
            </div>
          </>
        ) : (
          <span className="font-medium text-danger">No reason given yet. Accounts are being asked on every screen until they answer.</span>
        )}
      </div>

      {b.remarks.length > 1 ? (
        <div className="mt-3">
          <div className="text-xs font-medium text-muted">History</div>
          <ul className="mt-1 flex flex-col gap-1">
            {remarks.map((r, idx) => (
              <li key={idx} className="text-xs text-body">
                <Badge tone={r.side === "admin" ? "brand" : "neutral"}>{r.side === "admin" ? "Admin" : "Accounts"}</Badge>{" "}
                <b>{r.by}</b> · {fmt(r.at)} — {r.body}
              </li>
            ))}
          </ul>
          {b.remarks.length > 2 ? (
            <button type="button" className="mt-1 cursor-pointer text-xs text-brand hover:underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show less" : `Show all ${b.remarks.length}`}
            </button>
          ) : null}
        </div>
      ) : null}

      {nudging ? (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            rows={2}
            maxLength={500}
            placeholder="What do you want accounts to know? It reaches their bell and shows in their reminder."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setNudging(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy || note.trim().length < 3} onClick={() => act(nudgeAccounts({ breachId: b.breachId, body: note }))}>
              Send to accounts
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
