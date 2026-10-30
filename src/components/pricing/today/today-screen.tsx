"use client";

/* ---------------------------------------------------------------------------
 * PRICE DESK · TODAY — what needs the desk this morning, most money first.
 *
 * Five numbers, then "Needs you" (every row a link to the exact screen that
 * answers it), then the week ahead, then the morning check's findings. The
 * same component on all three doors; `canManage` false (the CRM) draws no
 * Dismiss and no Run now — and the actions refuse anyway, because a hidden
 * button is not a permission.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, cx, EmptyState, MetricStrip, PageHeader, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { money, moneyShort, shortDate } from "@/lib/format";
import { dismissFinding, runMorningCheckNow } from "@/lib/actions/price-today";
import { MORNING_KIND_LABEL, type MorningKind } from "@/lib/engines/price-morning-check";
import type { NeedKind, NeedRow, PriceDeskToday, TodayFinding } from "./types";

const NEED_LABEL: Record<NeedKind, string> = {
  billed_below: "Billed below price",
  change_to_approve: "Change to approve",
  special_price: "Special price",
  no_book: "No book",
  book_expiring: "Expiring",
  document_review: "PDF to review",
  finding: "Morning check",
};

const NEED_TONE: Record<NeedKind, "danger" | "warn" | "brand" | "neutral" | "muted"> = {
  billed_below: "danger",
  change_to_approve: "brand",
  special_price: "warn",
  no_book: "warn",
  book_expiring: "warn",
  document_review: "neutral",
  finding: "neutral",
};

const SEVERITY_TONE = { high: "danger", medium: "warn", low: "muted" } as const;
const SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekday(iso: string): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  return WEEKDAYS[d.getUTCDay()];
}

function findingLabel(kind: string): string {
  return MORNING_KIND_LABEL[kind as MorningKind] ?? kind;
}

export function TodayScreen({ basePath, canManage, data }: { basePath: string; canManage: boolean; data: PriceDeskToday }) {
  const router = useRouter();
  const { run } = useToast();
  const [running, setRunning] = React.useState(false);
  const [dismissing, setDismissing] = React.useState<TodayFinding | null>(null);

  const href = (suffix: string) => `${basePath}${suffix}`;
  const c = data.counts;

  async function runNow() {
    setRunning(true);
    try {
      const r = await run(runMorningCheckNow());
      if (r.ok) router.refresh();
    } finally {
      setRunning(false);
    }
  }

  const grouped = React.useMemo(() => {
    const m = new Map<string, TodayFinding[]>();
    for (const f of data.findings) m.set(f.kind, [...(m.get(f.kind) ?? []), f]);
    return [...m.entries()];
  }, [data.findings]);

  return (
    <div>
      <PageHeader
        title="Price Desk · Today"
        subtitle={`${weekday(data.day)} ${shortDate(data.day)} — what needs the desk, most money first.`}
        actions={
          canManage ? (
            <Button onClick={runNow} disabled={running}>
              {running ? "Checking…" : "Run the morning check now"}
            </Button>
          ) : null
        }
      />
      <PricingSubNav basePath={basePath} current="today" />

      <MetricStrip
        metrics={[
          { label: "Books in force", value: String(c.booksInForce) },
          { label: "Changes waiting approval", value: String(c.changesWaiting), tone: c.changesWaiting ? "danger" : "ink" },
          { label: "Going live this week", value: String(c.goingLiveThisWeek) },
          { label: "Special prices waiting", value: String(c.specialPricesWaiting) },
          {
            label: "Billed below price · 7 days",
            value: moneyShort(c.billedBelowPaise),
            tone: c.billedBelowPaise ? "danger" : "ink",
            sub: c.billedBelowPaise ? "under the list, cans × difference" : "nothing billed under a list",
          },
        ]}
      />

      <Card className="mb-4">
        <CardHeader title="Needs you" hint="Ordered by money at stake a month. Each row opens the screen that answers it." />
        {data.needs.length === 0 ? (
          <EmptyState title="Nothing needs the desk today." body="No change is waiting, no special price is asked, nothing was billed under a list this week and every shop is on a book." />
        ) : (
          <ul className="divide-y divide-divider">
            {data.needs.map((n) => (
              <NeedItem key={n.key} need={n} href={href(n.href)} />
            ))}
          </ul>
        )}
      </Card>

      <Card className="mb-4">
        <CardHeader title="This week" hint="Go-lives, changes waiting approval and books expiring, day by day." />
        <div className="grid grid-cols-1 gap-px bg-divider sm:grid-cols-7">
          {data.week.map((d) => (
            <div key={d.day} className={cx("min-h-24 bg-surface p-3", d.day === data.day && "bg-brand-soft/40")}>
              <div className="mb-2 text-xs font-medium text-muted">
                {weekday(d.day)} {shortDate(d.day)}
                {d.day === data.day ? " · today" : ""}
              </div>
              {d.events.length === 0 ? (
                <div className="text-xs text-muted">Nothing.</div>
              ) : (
                <ul className="space-y-1.5">
                  {d.events.map((e) => (
                    <li key={e.key}>
                      <Link href={href(e.href)} className="block text-[13px] leading-[18px] text-body hover:text-brand">
                        <Badge
                          tone={e.kind === "go_live" ? "success" : e.kind === "expiring" ? "warn" : "brand"}
                          className="mr-1"
                        >
                          {e.kind === "go_live" ? "Live" : e.kind === "expiring" ? "Ends" : "Approve"}
                        </Badge>
                        {e.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Morning check"
          hint={
            data.checkedAt
              ? `Every live book read for ladders, likely typos, GST, expiry, who it names and special prices.${data.dismissedToday ? ` ${data.dismissedToday} dismissed today.` : ""}`
              : "The check has not run today yet. It runs every night."
          }
        />
        {data.findings.length === 0 ? (
          <EmptyState
            title={data.checkedAt ? "The morning check found nothing." : "No findings for today yet."}
            body={data.checkedAt ? "Every live book passed." : canManage ? "Run it now to read every live book." : "It runs every night."}
          />
        ) : (
          <div className="divide-y divide-divider">
            {grouped.map(([kind, rows]) => (
              <div key={kind} className="px-5 py-3">
                <div className="mb-2 text-sm font-semibold text-ink">
                  {findingLabel(kind)} <span className="font-normal text-muted">· {rows.length}</span>
                </div>
                <ul className="space-y-2">
                  {rows.map((f) => (
                    <li key={f.id} className="flex items-start gap-3">
                      <Badge tone={SEVERITY_TONE[f.severity]} className="mt-0.5 shrink-0">
                        {SEVERITY_LABEL[f.severity]}
                      </Badge>
                      <Link href={href(f.href)} className="min-w-0 flex-1 text-[13px] leading-[19px] text-body hover:text-brand">
                        {f.message}
                        {f.moneyPaise ? <span className="ml-1 text-muted">({money(f.moneyPaise)} a month)</span> : null}
                      </Link>
                      {canManage ? (
                        <Button size="sm" variant="ghost" onClick={() => setDismissing(f)}>
                          Dismiss
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      {dismissing ? (
        <DismissDialog
          key={dismissing.id}
          finding={dismissing}
          onClose={() => setDismissing(null)}
          onDone={() => {
            setDismissing(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function NeedItem({ need, href }: { need: NeedRow; href: string }) {
  return (
    <li>
      <Link href={href} className="flex items-start gap-3 px-5 py-3 hover:bg-canvas">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={NEED_TONE[need.kind]}>{need.kind === "finding" && need.findingKind ? findingLabel(need.findingKind) : NEED_LABEL[need.kind]}</Badge>
            {need.severity ? <Badge tone={SEVERITY_TONE[need.severity]}>{SEVERITY_LABEL[need.severity]}</Badge> : null}
            {need.raisedByYou ? <Badge tone="muted">Someone else approves</Badge> : null}
            <span className="text-sm font-medium text-ink">{need.title}</span>
          </div>
          <div className="mt-0.5 text-[13px] leading-[18px] text-muted">{need.detail}</div>
        </div>
        <div className="shrink-0 text-right">
          {need.moneyPaise != null && need.moneyPaise !== 0 ? (
            <>
              <div className={cx("text-sm font-semibold", need.moneyPaise < 0 ? "text-danger" : "text-ink")}>
                {need.moneyPaise < 0 ? "−" : ""}
                {money(Math.abs(need.moneyPaise))}
              </div>
              <div className="text-[11px] text-muted">a month</div>
            </>
          ) : (
            <div className="text-[12px] text-muted">—</div>
          )}
        </div>
      </Link>
    </li>
  );
}

function DismissDialog({ finding, onClose, onDone }: { finding: TodayFinding; onClose: () => void; onDone: () => void }) {
  const { run } = useToast();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (!note.trim()) {
      setError("Say why this can be set aside — the next person reads it.");
      return;
    }
    setBusy(true);
    try {
      const r = await run(dismissFinding(finding.id, note));
      if (r.ok) onDone();
      else setError(r.error ?? null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Dismiss for today"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Dismissing…" : "Dismiss"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] leading-[19px] text-body">{finding.message}</p>
      <label className="mb-1 block text-xs font-medium text-muted" htmlFor="dismiss-note">
        Why it can be set aside
      </label>
      <Textarea
        id="dismiss-note"
        rows={3}
        value={note}
        invalid={!!error}
        onChange={(e) => {
          setNote(e.target.value);
          setError(null);
        }}
        className="w-full"
      />
      {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      <p className="mt-2 text-xs text-muted">It stays dismissed for today; tomorrow&apos;s check asks again if it is still true.</p>
    </Modal>
  );
}
