"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { STAGE_TONE, TellUsDialog } from "@/components/shell/feedback-button";
import { stamp, stampDate } from "@/lib/format";
import {
  IMPACT_LABELS,
  KIND_TILES,
  STAGE_LABELS,
  type FeedbackStage,
} from "@/lib/feedback-labels";
import type { MyFeedbackRow } from "@/lib/services/feedback-service";
import { FeedbackThread } from "./feedback-thread";
import { markFeedbackRead } from "@/lib/actions/feedback";

/* ---------------------------------------------------------------------------
 * The reporter's side, drawn inside whichever app they are in.
 *
 * A list of what they sent on the left — Open, New replies, Closed — and the
 * conversation on the right, with where it has got to beside it. The URL holds
 * the open report (`?r=`) and the tab (`?tab=`), so a notification can open one
 * report directly and the back button behaves.
 * ------------------------------------------------------------------------- */

type Tab = "open" | "replies" | "closed" | "all";

const TABS: { key: Tab; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "replies", label: "New replies" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

const isClosed = (r: MyFeedbackRow) => r.status === "done" || r.status === "declined";

function inTab(r: MyFeedbackRow, tab: Tab) {
  if (tab === "open") return !isClosed(r);
  if (tab === "closed") return isClosed(r);
  if (tab === "replies") return r.unread > 0;
  return true;
}

export function MyFeedbackScreen({
  rows,
  selectedId,
  tab: askedTab,
  viewerId,
  maxImages,
}: {
  rows: MyFeedbackRow[];
  selectedId: string | null;
  tab: string | null;
  viewerId: string;
  maxImages: number;
}) {
  const pathname = usePathname();
  const [composing, setComposing] = React.useState(false);

  const counts = Object.fromEntries(TABS.map((t) => [t.key, rows.filter((r) => inTab(r, t.key)).length])) as Record<Tab, number>;
  const asked = rows.find((r) => r.id === selectedId) ?? null;
  const tab: Tab = TABS.some((t) => t.key === askedTab)
    ? (askedTab as Tab)
    : asked
      ? isClosed(asked)
        ? "closed"
        : "open"
      : counts.replies
        ? "replies"
        : counts.open
          ? "open"
          : "all";
  const shown = rows.filter((r) => inTab(r, tab));
  const selected = asked ?? shown[0] ?? null;

  // A report on the screen has been read — including the one opened for them
  // because nothing was asked for. The server marks a report named in the
  // address before it draws; this covers the one chosen here.
  const router = useRouter();
  const unreadShown = selected && selected.unread ? selected.id : null;
  React.useEffect(() => {
    if (!unreadShown) return;
    markFeedbackRead(unreadShown).then(() => router.refresh());
  }, [unreadShown, router]);

  const href = (q: { r?: string; tab?: Tab }) => {
    const p = new URLSearchParams();
    if (q.tab) p.set("tab", q.tab);
    if (q.r) p.set("r", q.r);
    const s = p.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink">Feedback</h1>
        <Button variant="primary" onClick={() => setComposing(true)}>
          + Tell us something
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="mt-5 rounded-[8px] border border-line bg-surface px-6 py-12 text-center">
          <div className="text-base font-semibold text-ink">You have not sent anything in yet</div>
          <p className="mx-auto mt-1.5 max-w-[460px] text-sm text-muted">
            The Feedback button sits in the header of every app. Whatever you send — a fault, an idea or a
            question — shows here with the reply.
          </p>
          <Button variant="primary" className="mt-4" onClick={() => setComposing(true)}>
            Tell us something
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-start gap-4">
          {/* the list */}
          <section className="min-w-0 flex-[1_1_320px] overflow-hidden rounded-[8px] border border-line bg-surface lg:max-w-[380px]">
            <div className="flex flex-wrap gap-1 p-2.5" role="tablist" aria-label="Which reports">
              {TABS.map((t) => (
                <Link
                  key={t.key}
                  href={href({ tab: t.key })}
                  scroll={false}
                  role="tab"
                  aria-selected={tab === t.key}
                  className={cx(
                    "h-[30px] rounded-[7px] px-3 text-[13px] leading-[30px] no-underline hover:no-underline",
                    tab === t.key ? "bg-brand-soft font-semibold text-brand-deep" : "font-medium text-muted hover:text-body",
                  )}
                >
                  {t.label} {counts[t.key]}
                </Link>
              ))}
            </div>
            {shown.length ? (
              shown.map((r) => (
                <Link
                  key={r.id}
                  href={href({ tab, r: r.id })}
                  scroll={false}
                  aria-current={selected?.id === r.id ? "true" : undefined}
                  className={cx(
                    "flex gap-2.5 border-t border-divider px-3.5 py-3 no-underline hover:no-underline",
                    selected?.id === r.id ? "bg-brand-soft/60" : "hover:bg-page",
                  )}
                >
                  <span
                    className={cx("mt-1.5 h-2 w-2 flex-none rounded-full", r.unread ? "bg-brand" : "bg-transparent")}
                    aria-label={r.unread ? "New reply" : undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cx("block text-sm leading-[19px] text-ink", r.unread ? "font-semibold" : "font-medium")}>
                      {r.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {r.ref}
                      {r.lastLine ? ` · ${r.lastLine.who}: ${r.lastLine.text}` : ` · sent ${stampDate(r.createdAt)}`}
                    </span>
                    <span className="mt-1.5 flex gap-1.5">
                      <StagePill stage={r.stage} />
                      {r.alsoReported.length ? (
                        <span className="rounded-full bg-canvas px-2 py-px text-[11px] font-semibold text-body">
                          +{r.alsoReported.length} others
                        </span>
                      ) : null}
                    </span>
                  </span>
                </Link>
              ))
            ) : (
              <div className="border-t border-divider px-3.5 py-6 text-center text-[13px] text-muted">
                Nothing here.
              </div>
            )}
            <div className="border-t border-divider px-3.5 py-2.5 text-xs text-muted">
              Everything you sent, from every app. Nothing is ever deleted.
            </div>
          </section>

          {/* the conversation */}
          {selected ? (
            <section className="min-w-0 flex-[999_1_480px] overflow-hidden rounded-[8px] border border-line bg-surface">
              <div className="flex flex-wrap items-start gap-3 border-b border-divider px-5 py-4">
                <div className="min-w-[260px] flex-1">
                  <div className="text-xs text-muted">
                    {selected.ref} · {KIND_TILES[selected.kind]}
                    {selected.impact ? ` · ${IMPACT_LABELS[selected.impact].toLowerCase()}` : ""}
                  </div>
                  <h2 className="mt-1 text-lg leading-6 font-bold text-ink">{selected.title}</h2>
                  {selected.sameAs ? (
                    <div className="mt-1 text-xs text-muted">
                      Following {selected.sameAs.ref} — the report about the same problem. Replies there reach you.
                    </div>
                  ) : null}
                </div>
                <StagePill stage={selected.stage} large />
              </div>

              <div className="flex flex-wrap">
                <div className="min-w-0 flex-[999_1_380px] bg-page px-5 py-4">
                  <FeedbackThread report={selected} viewerId={viewerId} maxImages={maxImages} view="reporter" />
                </div>
                <aside className="min-w-0 flex-[1_1_200px] border-l border-divider px-4.5 py-4">
                  <Progress row={selected} />
                  <div className="my-4 h-px bg-divider" />
                  <div className="mb-1.5 text-xs font-semibold text-ink">Sent from</div>
                  <Fact k="Screen">{selected.path ? <span className="font-mono text-[11px]">{selected.path}</span> : "—"}</Fact>
                  <Fact k="Sent">{stamp(selected.createdAt)}</Fact>
                  {selected.alsoReported.length ? (
                    <Fact k="Also">
                      {selected.alsoReported.length} {selected.alsoReported.length === 1 ? "person" : "people"}
                    </Fact>
                  ) : null}
                  {selected.assigneeName ? <Fact k="With">{selected.assigneeName}</Fact> : null}
                </aside>
              </div>
            </section>
          ) : null}
        </div>
      )}

      <TellUsDialog open={composing} onClose={() => setComposing(false)} />
    </div>
  );
}

export function StagePill({ stage, large }: { stage: FeedbackStage; large?: boolean }) {
  return (
    <span
      className={cx(
        "flex-none rounded-full font-semibold whitespace-nowrap",
        large ? "px-2.5 py-1 text-xs" : "px-2 py-px text-[11px]",
        STAGE_TONE[stage],
      )}
    >
      {STAGE_LABELS[stage]}
    </span>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1 text-xs text-body">
      <span className="w-14 flex-none text-muted">{k}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** "13 Nov" — the progress line is read at a glance, the year never matters there. */
function shortDay(at: string) {
  return stampDate(at).split(" ").slice(0, 2).join(" ");
}

/** Sent → Seen → Being looked at → Done, each dated from the thread itself. */
function Progress({ row }: { row: MyFeedbackRow }) {
  const visible = row.messages.filter((m) => !m.internal);
  const firstTeam = visible.find((m) => !m.fromSubmitter)?.at ?? null;
  const looked = visible.find((m) => m.statusTo === "in_progress")?.at ?? null;
  const done = [...visible].reverse().find((m) => m.statusTo === "done" || m.statusTo === "declined") ?? null;
  const declined = row.status === "declined";

  const steps: { label: string; at: string | null; reached: boolean }[] = [
    { label: "Sent", at: row.createdAt, reached: true },
    { label: "Seen by the team", at: firstTeam, reached: row.seen },
    { label: "Being looked at", at: looked, reached: row.status !== "new" && !declined },
    {
      label: declined ? "Not doing" : row.verdict === "fixed" ? "Done — you confirmed" : "Done",
      at: done?.at ?? null,
      reached: row.status === "done" || declined,
    },
  ];
  const current = steps.findIndex((s) => !s.reached);

  return (
    <div>
      <div className="mb-2.5 text-xs font-semibold text-ink">Progress</div>
      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => (
          <li key={s.label} className={cx("flex items-center gap-2 text-[13px]", s.reached ? (declined && i === 3 ? "text-muted" : "text-success") : i === current ? "font-semibold text-ink" : "text-muted")}>
            <span
              className={cx(
                "h-4 w-4 flex-none rounded-full",
                s.reached ? (declined && i === 3 ? "bg-line-strong" : "bg-success") : i === current ? "border-2 border-success" : "border-2 border-line",
              )}
              aria-hidden
            />
            <span>
              {s.label}
              {s.reached && s.at ? <span className="font-normal text-muted"> · {shortDay(s.at)}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
