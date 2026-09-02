"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  PageHeader,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { carryReminderForward, completeReminder, submitEod } from "@/lib/actions/crm";
import { ageLabel, longDate, money, moneyShort, shortDate, stamp } from "@/lib/format";
import { EOD_PERIODS, EOD_PERIOD_LABELS, type EodPeriod } from "@/lib/business-date";

type Due = {
  id: string;
  note: string;
  dueDate: string;
  customerName: string;
  overdueDays: number;
};

/** "12 Aug 2026" for one day, "12 Aug – 18 Aug 2026" for a span. */
function rangeLabel(from: string, to: string): string {
  return from === to ? longDate(from) : `${shortDate(from)} – ${longDate(to)}`;
}

export function EodScreen({
  scopeLabel,
  period,
  rangeFrom,
  rangeTo,
  isManager,
  lines,
  message,
  dueReminders,
  blockingMessage,
  submittedAt,
  team,
  teamMessage,
}: {
  scopeLabel: string;
  period: EodPeriod;
  rangeFrom: string;
  rangeTo: string;
  isManager: boolean;
  lines: Array<{ k: string; v: string }>;
  /** Only for "today" — a range has no single WhatsApp message to paste. */
  message: string | null;
  dueReminders: Due[];
  /** The engine's own wording for why the report is blocked. */
  blockingMessage: string;
  submittedAt: string | null;
  team: Array<{
    name: string;
    calls: number;
    connected: number;
    missed: number;
    orders: number;
    value: number;
    percent: number;
  }>;
  teamMessage: string | null;
}) {
  const router = useRouter();
  const { run, push } = useToast();
  const [view, setView] = React.useState<"mine" | "team">("mine");
  const [busy, setBusy] = React.useState(false);

  const isToday = period === "today";
  // Reminders due today block finalising TODAY's report — that gate is real
  // whatever period happens to be on screen, but it is only shown alongside
  // the Submit button, which only exists for today.
  const blocked = isToday && dueReminders.length > 0;

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="EOD report"
        subtitle={`${scopeLabel} · ${isToday ? "generated from today's activity" : "derived from the activity logged"} · ${rangeLabel(rangeFrom, rangeTo)}`}
        actions={
          <>
            <PeriodPicker period={period} from={rangeFrom} to={rangeTo} />
            {isManager ? (
              <div className="flex overflow-hidden rounded-[4px] border border-line bg-surface">
                {(["mine", "team"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={cx(
                      "h-9 cursor-pointer px-3 text-sm",
                      view === v
                        ? "bg-brand-soft font-medium text-[#5223E0]"
                        : "text-body hover:bg-canvas",
                    )}
                  >
                    {v === "mine" ? "My report" : "Team roll-up"}
                  </button>
                ))}
              </div>
            ) : null}
            {isToday ? (
              <Button
                variant="primary"
                disabled={busy || blocked}
                title={
                  blocked
                    ? "Close or carry forward the reminders due today first"
                    : submittedAt
                      ? "Submitting again replaces today's report"
                      : undefined
                }
                onClick={async () => {
                  setBusy(true);
                  // `finally`: `run` re-throws, and a telecaller at the end
                  // of the day must be able to press this again.
                  try {
                    const result = await run(submitEod(message ?? ""));
                    if (result.ok) router.refresh();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {submittedAt ? "Resubmit EOD" : "Submit EOD"}
              </Button>
            ) : null}
          </>
        }
      />

      {submittedAt && !blocked ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-[4px] border border-success/30 bg-success-soft px-4 py-2.5">
          <Icon name="check" size={16} className="text-success" />
          <span className="text-sm text-ink">
            Submitted at {stamp(submittedAt)}. Resubmitting replaces it with the current
            numbers.
          </span>
        </div>
      ) : null}

      {blocked ? (
        <div className="mb-4 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <div className="text-sm font-medium text-warn-ink">
            {blockingMessage}
          </div>
          <div className="mt-2.5 flex flex-col gap-2">
            {dueReminders.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 rounded-[4px] border border-warn-line bg-surface px-3 py-2"
              >
                <Badge tone={d.overdueDays > 0 ? "danger" : "warn"}>
                  {d.overdueDays > 0 ? `${ageLabel(d.overdueDays)} late` : "Due today"}
                </Badge>
                <span className="flex-1 text-sm text-ink">
                  {d.note} <span className="text-muted">- {d.customerName}</span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    await run(completeReminder(d.id));
                    router.refresh();
                  }}
                >
                  Mark done
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    await run(carryReminderForward(d.id));
                    router.refresh();
                  }}
                >
                  Carry forward
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_clamp(380px,34%,520px)] items-start gap-4">
        <Card>
          <CardHeader
            title={
              view === "mine"
                ? isToday
                  ? "Today's numbers"
                  : `${EOD_PERIOD_LABELS[period]} — numbers`
                : "Team roll-up"
            }
            hint={
              view === "mine"
                ? "Derived from what you logged - a thin report means thin logging, not a thin day"
                : undefined
            }
          />
          {view === "mine" ? (
            <div className="px-5 pt-2 pb-4">
              {lines.map((l) => (
                <div
                  key={l.k}
                  className="flex items-center justify-between border-b border-canvas py-2.5 last:border-0"
                >
                  <span className="text-sm text-body">{l.k}</span>
                  <span className="text-sm font-medium text-ink">{l.v}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-auto">
              {teamMessage ? (
                <div className="flex items-center gap-3 border-b border-divider px-5 py-2.5">
                  <span className="text-[13px] text-muted">
                    The same roll-up, formatted for the owners&rsquo; group.
                  </span>
                  <span className="flex-1" />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(teamMessage);
                      push("Team roll-up copied");
                    }}
                  >
                    Copy team roll-up
                  </Button>
                </div>
              ) : null}
              <table>
                <thead>
                  <tr>
                    <Th>Telecaller</Th>
                    <Th align="right">Calls</Th>
                    <Th align="right">Connected</Th>
                    <Th align="right">Missed</Th>
                    <Th align="right">Orders</Th>
                    <Th align="right">Value</Th>
                    <Th align="right">Target</Th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((t) => (
                    <Tr key={t.name} className="hover:bg-canvas">
                      <Td className="font-medium text-ink">{t.name}</Td>
                      <Td align="right">{t.calls}</Td>
                      <Td align="right">{t.connected}</Td>
                      <Td align="right" className={t.missed > 5 ? "text-danger" : ""}>
                        {t.missed}
                      </Td>
                      <Td align="right">{t.orders}</Td>
                      <Td align="right" className="font-medium text-ink">
                        {moneyShort(t.value)}
                      </Td>
                      <Td align="right">{t.percent}%</Td>
                    </Tr>
                  ))}
                  <tr className="border-t border-line bg-canvas">
                    <Td className="font-semibold text-ink">Total</Td>
                    <Td align="right" className="font-medium text-ink">
                      {team.reduce((a, t) => a + t.calls, 0)}
                    </Td>
                    <Td align="right" className="font-medium text-ink">
                      {team.reduce((a, t) => a + t.connected, 0)}
                    </Td>
                    <Td align="right" className="font-medium text-ink">
                      {team.reduce((a, t) => a + t.missed, 0)}
                    </Td>
                    <Td align="right" className="font-medium text-ink">
                      {team.reduce((a, t) => a + t.orders, 0)}
                    </Td>
                    <Td align="right" className="font-semibold text-ink">
                      {money(team.reduce((a, t) => a + t.value, 0))}
                    </Td>
                    <Td align="right" className="font-medium text-ink">
                      {team.length
                        ? Math.round(team.reduce((a, t) => a + t.percent, 0) / team.length)
                        : 0}
                      %
                    </Td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {isToday && message ? (
          <Card>
            <div className="flex items-center justify-between border-b border-divider px-5 py-3.5">
              <span className="text-lg font-semibold text-ink">WhatsApp message</span>
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(message);
                    push("Message copied");
                  } catch {
                    push("The browser blocked the clipboard.", "error");
                  }
                }}
              >
                <Icon name="copy" size={14} strokeWidth={1.8} />
                Copy message
              </Button>
            </div>
            <div className="bg-canvas p-5">
              <pre className="m-0 rounded-[6px] border border-line bg-surface p-4 font-mono text-[13px] leading-5 whitespace-pre-wrap text-ink">
                {message}
              </pre>
              <p className="mt-2.5 text-[13px] text-muted">
                Asterisks render as bold in WhatsApp. Paste straight into the team group.
              </p>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="border-b border-divider px-5 py-3.5">
              <span className="text-lg font-semibold text-ink">Historical view</span>
            </div>
            <div className="px-5 py-5">
              <p className="text-[13px] text-muted">
                {EOD_PERIOD_LABELS[period]} is a read-only look back — there is no single
                day&rsquo;s WhatsApp message to paste, and nothing to submit. Switch the
                period to Today to submit or resubmit today&rsquo;s report.
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * Today / Yesterday / Last 7 days / This month / Last month / Custom range.
 *
 * Lives in the URL rather than in component state — the same reasoning
 * `reports/filters.tsx` follows: a filtered view can be sent to somebody, and
 * the back button works. `from`/`to` are only sent when the period is
 * `custom`; carrying them for every period would leave a stray `from=` in the
 * address bar after switching back to Today.
 */
function PeriodPicker({
  period,
  from,
  to,
}: {
  period: EodPeriod;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = React.useTransition();

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    start(() => router.push(`${pathname}?${next.toString()}`));
  };

  return (
    <div className={cx("flex items-center gap-2", pending && "opacity-60")}>
      <select
        value={period}
        onChange={(e) =>
          set(
            e.target.value === "custom"
              ? { period: e.target.value, from, to }
              : { period: e.target.value, from: null, to: null },
          )
        }
        className="h-9 rounded-[4px] border border-line bg-surface px-2.5 text-sm"
      >
        {EOD_PERIODS.map((p) => (
          <option key={p} value={p}>
            {EOD_PERIOD_LABELS[p]}
          </option>
        ))}
      </select>
      {period === "custom" ? (
        <>
          <input
            type="date"
            value={from}
            onChange={(e) => set({ period: "custom", from: e.target.value })}
            className="h-9 rounded-[4px] border border-line bg-surface px-2 text-sm"
          />
          <span className="text-sm text-muted">–</span>
          <input
            type="date"
            value={to}
            onChange={(e) => set({ period: "custom", to: e.target.value })}
            className="h-9 rounded-[4px] border border-line bg-surface px-2 text-sm"
          />
        </>
      ) : null}
    </div>
  );
}
