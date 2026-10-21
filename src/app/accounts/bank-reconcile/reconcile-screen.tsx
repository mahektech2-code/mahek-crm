"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { bankAccept, bankAcceptAll, bankConfirmAmount, bankDismiss, bankIgnore, bankRestore, bankReverseForReturn, bankUndo } from "@/lib/actions/bank-statements";
import { BANK_FLAGS, type Candidate } from "@/lib/engines/bank-statements";
import type { LineDetail, LineView, ReconcileFilter, ReconcileTab, ReconcileView } from "@/lib/services/bank-statement-service";
import { Acc, Btn, dayLabel, Dialog, FieldLabel, figure, inputCls, inr, labelCls, LinkBtn, Note, Pill, type PillTone, Sel, TabCount, tabCls, timeLabel } from "../bank-statements/bank-ui";
import { EditLineDialog, MarkDialog } from "./mark-dialog";

/* ---------------------------------------------------------------------------
 * ACCOUNTS → BANK STATEMENT MANAGEMENT → RECONCILE.
 *
 * Every line ends matched, marked or set aside. The list is on the left and
 * the line picked is on the right, with what could explain it: the best
 * match, why, what confirming it will do, and the other possibilities. The
 * Flagged tab is a table of its own, with what each flag lets you do.
 * ------------------------------------------------------------------------- */

const TAB_LABEL: Record<ReconcileTab, string> = { todo: "To do", suggested: "Suggested", unmatched: "Unmatched", flagged: "Flagged", matched: "Matched", ignored: "Ignored", all: "All" };

export function ReconcileScreen({
  view,
  filter,
  detail,
  today,
  canRecord,
  canConfirm,
}: {
  view: ReconcileView;
  filter: ReconcileFilter;
  detail: LineDetail | null;
  today: string;
  canRecord: boolean;
  canConfirm: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [mark, setMark] = React.useState<{ id: string; as?: string } | null>(null);
  const [edit, setEdit] = React.useState<LineView | null>(null);
  const [ignore, setIgnore] = React.useState<{ id: string; reason: string } | null>(null);
  const [q, setQ] = React.useState(filter.q ?? "");

  const href = React.useCallback(
    (set: Record<string, string | null>) => {
      const u = new URLSearchParams();
      const cur: Record<string, string | null> = {
        account: filter.account,
        tab: filter.tab === "todo" ? null : filter.tab,
        q: filter.q,
        dir: filter.dir === "both" ? null : filter.dir,
        period: filter.period === "all" ? null : filter.period,
        upload: filter.upload,
        line: detail?.line.id ?? null,
      };
      for (const [k, v] of Object.entries({ ...cur, ...set })) if (v) u.set(k, v);
      const s = u.toString();
      return s ? `${pathname}?${s}` : pathname;
    },
    [filter, detail, pathname],
  );
  const go = (set: Record<string, string | null>) => router.push(href(set), { scroll: false });

  async function act<T extends { ok: boolean; message?: string; error?: string }>(p: Promise<T>, after?: () => void) {
    setBusy(true);
    try {
      const r = await toast.run(p);
      if (r.ok) {
        after?.();
        router.refresh();
      }
      return r;
    } finally {
      setBusy(false);
    }
  }

  const flaggedTable = filter.tab === "flagged" && !detail;
  const confirmTitle = canConfirm ? undefined : "Matching confirms or records money — that is the Accounts manager's.";

  return (
    <div className="px-6 pt-5 pb-12">
      <div className="mb-3.5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-heading">Reconcile</h1>
          <div className="mt-0.5 text-[12.5px] text-muted">
            {filter.tab === "flagged" ? "Flagged lines are never matched on their own." : "Every line ends matched, marked or ignored. Pick a line to see what it could be."}
          </div>
        </div>
        <Link href="/accounts/bank-statements?new=1" className="ml-auto inline-flex h-[34px] items-center rounded-[9px] border border-line bg-surface px-3.5 text-[13px] font-[650] text-ink no-underline hover:bg-canvas hover:no-underline">
          ⤒ Upload bank PDF
        </Link>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {view.accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => go({ account: a.id, line: null })}
            className={cx(
              "flex cursor-pointer items-center gap-[9px] rounded-[10px] border bg-surface px-3.5 py-2",
              filter.account === a.id ? "border-brand shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line hover:border-line-strong",
            )}
          >
            <Acc mark={a.mark} name={a.name} last4={a.last4} />
            <span className="text-[11.5px] text-muted tabular-nums">{a.toDo ? `${a.toDo} to do` : "clear"}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => go({ account: null, line: null })}
          className={cx("flex cursor-pointer items-center gap-[9px] rounded-[10px] border bg-surface px-3.5 py-2", !filter.account ? "border-brand shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line hover:border-line-strong")}
        >
          <b className="text-[13px] font-bold text-ink">All accounts</b>
          <span className="text-[11.5px] text-muted tabular-nums">{view.allToDo} to do</span>
        </button>
        {filter.upload ? (
          <span className="flex items-center gap-2 rounded-[10px] border border-dashed border-line-strong px-3 py-2 text-[12px] text-muted">
            Lines of one upload
            <LinkBtn onClick={() => go({ upload: null, line: null })}>show every upload</LinkBtn>
          </span>
        ) : null}
      </div>

      <div className={cx(flaggedTable ? "" : "grid grid-cols-[minmax(0,1fr)_400px] items-start gap-3.5")}>
        <div className="min-w-0 overflow-hidden rounded-[12px] border border-line bg-surface">
          <div className="flex gap-0.5 overflow-x-auto border-b border-line bg-surface px-3">
            {(Object.keys(TAB_LABEL) as ReconcileTab[]).map((t) => (
              <button key={t} type="button" className={tabCls(filter.tab === t)} onClick={() => go({ tab: t === "todo" ? null : t, line: null })}>
                {TAB_LABEL[t]}
                <TabCount on={filter.tab === t}>{view.counts[t]}</TabCount>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 border-b border-divider px-3 py-2.5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                go({ q: q.trim() || null, line: null });
              }}
            >
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search narration, UTR, amount…" className="h-8 w-[230px] rounded-[8px] border border-line px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-brand" />
            </form>
            <Sel className="w-[148px]" value={filter.dir} onChange={(e) => go({ dir: e.target.value === "both" ? null : e.target.value, line: null })}>
              <option value="both">Money in and out</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </Sel>
            <Sel className="w-[120px]" value={filter.period} onChange={(e) => go({ period: e.target.value === "all" ? null : e.target.value, line: null })}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="month">This month</option>
              <option value="all">Any date</option>
            </Sel>
            {view.acceptable && (filter.tab === "todo" || filter.tab === "suggested" || filter.tab === "all") && view.rows.some((r) => r.state === "suggested") ? (
              <Btn
                small
                className="ml-auto"
                disabled={busy || !canConfirm}
                title={confirmTitle}
                onClick={() => act(bankAcceptAll(view.rows.filter((r) => r.state === "suggested").map((r) => r.id)))}
              >
                Accept all {Math.min(view.acceptable, view.rows.filter((r) => r.state === "suggested").length)} suggestions
              </Btn>
            ) : null}
          </div>
          {flaggedTable ? (
            <FlaggedTable
              rows={view.rows}
              busy={busy}
              canConfirm={canConfirm}
              canRecord={canRecord}
              onOpen={(id) => go({ line: id })}
              onMark={(id) => setMark({ id })}
              onEdit={(l) => setEdit(l)}
              onIgnore={(id, reason) => setIgnore({ id, reason })}
              onReverse={(l) => act(bankReverseForReturn(l.id, l.flagReceiptId!))}
              onShort={(l) => act(bankConfirmAmount(l.id, l.flagReceiptId!))}
              onHeld={(l) => l.suggestion && act(bankAccept(l.id, l.suggestion))}
            />
          ) : (
            <LineTable rows={view.rows} selected={detail?.line.id ?? null} onPick={(id) => go({ line: id })} />
          )}
          {view.more ? <div className="border-t border-divider px-3 py-2.5 text-[12px] text-muted">Showing the first 200. Narrow by account, date or search to see the rest.</div> : null}
          {!view.rows.length ? (
            <div className="px-3 py-12 text-center text-[12.5px] text-muted">
              {filter.tab === "todo" ? "Nothing to do here. Every line is matched, marked or set aside." : "No lines here."}
            </div>
          ) : null}
        </div>

        {flaggedTable ? null : detail ? (
          <LinePanel
            d={detail}
            today={today}
            busy={busy}
            canConfirm={canConfirm}
            canRecord={canRecord}
            onAccept={(c, via) => act(bankAccept(detail.line.id, c, via))}
            onDismiss={(c) => act(bankDismiss(detail.line.id, c))}
            onMark={(as) => setMark({ id: detail.line.id, as })}
            onIgnore={(reason) => setIgnore({ id: detail.line.id, reason })}
            onRestore={() => act(bankRestore(detail.line.id))}
            onUndo={() => act(bankUndo(detail.line.id))}
            onEdit={() => setEdit(detail.line)}
            onReverse={() => act(bankReverseForReturn(detail.line.id, detail.line.flagReceiptId!))}
            onShort={() => act(bankConfirmAmount(detail.line.id, detail.line.flagReceiptId!))}
          />
        ) : (
          <div className="rounded-[12px] border border-line bg-surface p-5 text-[12.5px] text-muted">Pick a line to see what it could be.</div>
        )}
      </div>

      {mark ? <MarkDialog lineId={mark.id} preset={mark.as} onClose={() => setMark(null)} onDone={() => router.refresh()} /> : null}
      {edit ? <EditLineDialog line={edit} onClose={() => setEdit(null)} onDone={() => router.refresh()} /> : null}
      {ignore ? (
        <Dialog
          open
          onClose={() => setIgnore(null)}
          title="Set this line aside"
          width={560}
          top={140}
          foot={
            <>
              <Btn className="ml-auto" onClick={() => setIgnore(null)}>
                Cancel
              </Btn>
              <Btn tone="primary" disabled={busy || ignore.reason.trim().length < 4} onClick={() => act(bankIgnore(ignore.id, ignore.reason), () => setIgnore(null))}>
                Set aside
              </Btn>
            </>
          }
        >
          <div className="flex flex-col gap-3 px-5 py-4">
            <div>
              <FieldLabel required>Why does this line need no record?</FieldLabel>
              <input autoFocus className={inputCls} value={ignore.reason} onChange={(e) => setIgnore({ ...ignore, reason: e.target.value })} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["Duplicate line", "Petty cash — entered on Petty Cash", "Reversal by the bank", "Not our money"].map((c) => (
                <button key={c} type="button" onClick={() => setIgnore({ ...ignore, reason: c })} className="cursor-pointer rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-body hover:border-brand">
                  {c}
                </button>
              ))}
            </div>
            <Note tone="i">A line set aside counts as explained. It can be brought back from the Ignored tab.</Note>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ the list */

/** A flag in two words, for the State column. */
const FLAG_SHORT: Record<string, string> = { balance: "balance", low_conf: "check figure", returned: "returned", dup_ref: "same UTR", short: "short", held: "customer held", large: "large" };

function statePill(l: LineView): { tone: PillTone; text: string } {
  const short = (c: Candidate | null) => {
    if (!c) return "";
    if (c.kind === "receipt" || c.kind === "payout" || c.kind === "txn") return c.label.split(" · ")[0].replace(/^(Receipt|Vendor payout) /, "");
    if (c.kind === "bill") return "open bill";
    if (c.kind === "transfer") return "transfer";
    if (c.kind === "charges") return "charges";
    return "interest";
  };
  switch (l.state) {
    case "matched":
      return { tone: "ok", text: `Matched · ${l.matchLabels[0]?.split(" · ")[0].replace(/^Receipt /, "") ?? (l.markedAs ? l.markedAs.replace(/_/g, " ") : "")}` };
    case "ignored":
      return { tone: "muted", text: `Ignored · ${l.ignoreReason ?? ""}` };
    case "flagged":
      return { tone: "flag", text: `Flagged · ${FLAG_SHORT[l.flag ?? ""] ?? "check"}` };
    case "suggested":
      return { tone: "brand", text: `Suggested · ${short(l.suggestion)}` };
    default:
      return { tone: "danger", text: "Unmatched" };
  }
}

function LineTable({ rows, selected, onPick }: { rows: LineView[]; selected: string | null; onPick: (id: string) => void }) {
  const th = "border-b border-line bg-[#fafbfc] px-3 py-[9px] text-left text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-muted uppercase";
  const td = "border-b border-divider px-3 py-2.5 text-[12.8px] whitespace-nowrap text-body";
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col className="w-[34px]" />
        <col className="w-[70px]" />
        <col />
        <col className="w-[120px]" />
        <col className="w-[190px]" />
      </colgroup>
      <thead>
        <tr>
          <th className={th} />
          <th className={th}>Date</th>
          <th className={th}>Narration</th>
          <th className={cx(th, "text-right")}>Amount</th>
          <th className={th}>State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const p = statePill(l);
          const credit = l.creditPaise > 0;
          return (
            <tr key={l.id} onClick={() => onPick(l.id)} className={cx("cursor-pointer", selected === l.id ? "bg-brand-soft" : "hover:bg-[#fbfaff]")}>
              <td className={td}>
                <span className={cx("inline-block h-[9px] w-[9px] rounded-[2px]", credit ? "bg-success" : "bg-danger")} />
              </td>
              <td className={td}>{dayLabel(l.date)}</td>
              <td className={cx(td, "overflow-hidden text-ellipsis")} title={l.description}>
                <b className="font-[650] text-ink">{l.description}</b>
              </td>
              <td className={cx(td, "text-right font-[650] tabular-nums", credit ? "text-success" : "text-danger")}>
                {credit ? "+" : "−"}
                {figure(l.debitPaise || l.creditPaise)}
              </td>
              <td className={cx(td, "overflow-hidden")}>
                <Pill tone={p.tone} title={p.text}>
                  {p.text}
                </Pill>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FlaggedTable({
  rows,
  busy,
  canConfirm,
  canRecord,
  onOpen,
  onMark,
  onEdit,
  onIgnore,
  onReverse,
  onShort,
  onHeld,
}: {
  rows: LineView[];
  busy: boolean;
  canConfirm: boolean;
  canRecord: boolean;
  onOpen: (id: string) => void;
  onMark: (id: string) => void;
  onEdit: (l: LineView) => void;
  onIgnore: (id: string, reason: string) => void;
  onReverse: (l: LineView) => void;
  onShort: (l: LineView) => void;
  onHeld: (l: LineView) => void;
}) {
  const th = "border-b border-line bg-[#fafbfc] px-3 py-[9px] text-left text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-muted uppercase";
  const td = "border-b border-divider bg-[#fffaf3] px-3 py-2.5 align-top text-[12.8px] text-body";
  const t = canConfirm ? undefined : "The Accounts manager's.";
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={th}>Date</th>
          <th className={th}>Account</th>
          <th className={th}>Narration</th>
          <th className={cx(th, "text-right")}>Amount</th>
          <th className={th}>Why it is flagged</th>
          <th className={th}>What you can do</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const credit = l.creditPaise > 0;
          const amount = l.debitPaise || l.creditPaise;
          return (
            <tr key={l.id}>
              <td className={cx(td, "whitespace-nowrap")}>{dayLabel(l.date)}</td>
              <td className={cx(td, "whitespace-nowrap")}>
                <Acc mark={l.mark} name={l.account} last4={l.last4} />
              </td>
              <td className={cx(td, "max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap")} title={l.description}>
                <button type="button" onClick={() => onOpen(l.id)} className="cursor-pointer border-none bg-transparent p-0 text-left font-[650] whitespace-nowrap text-ink hover:underline">
                  {l.description}
                </button>
              </td>
              <td className={cx(td, "text-right font-[650] whitespace-nowrap tabular-nums", credit ? "text-success" : "text-danger")}>
                {credit ? "+" : "−"}
                {figure(amount)}
              </td>
              <td className={cx(td, "min-w-[260px]")}>
                <Pill tone="flag">{BANK_FLAGS[l.flag as keyof typeof BANK_FLAGS] ?? l.flag}</Pill>
                <div className="mt-1 text-[11.5px] leading-[1.35] text-muted">{l.flagNote}</div>
              </td>
              <td className={cx(td, "whitespace-nowrap")}>
                <div className="flex flex-nowrap items-center gap-1.5">
                  {l.flag === "returned" && l.flagReceiptId ? (
                    <Btn small tone="danger" disabled={busy || !canConfirm} title={t} onClick={() => onReverse(l)}>
                      Reverse {l.flagReceiptLabel}
                    </Btn>
                  ) : null}
                  {l.flag === "short" && l.flagReceiptId ? (
                    <Btn small tone="ok" disabled={busy || !canConfirm} title={t} onClick={() => onShort(l)}>
                      Confirm {inr(amount)}
                    </Btn>
                  ) : null}
                  {l.flag === "held" && l.suggestion ? (
                    <Btn small tone="ok" disabled={busy || !canConfirm} title={t} onClick={() => onHeld(l)}>
                      Confirm {l.flagReceiptLabel}
                    </Btn>
                  ) : null}
                  {l.flag === "dup_ref" ? (
                    <>
                      <Btn small onClick={() => onOpen(l.id)}>
                        Compare
                      </Btn>
                      <Btn small disabled={busy || !canRecord} onClick={() => onIgnore(l.id, "Duplicate of another line with the same UTR")}>
                        Ignore as duplicate
                      </Btn>
                    </>
                  ) : null}
                  {l.flag === "balance" || l.flag === "low_conf" ? (
                    <>
                      <Btn small disabled={busy || !canRecord} onClick={() => onEdit(l)}>
                        {l.flag === "balance" ? "Fix the figure" : "Fix the line"}
                      </Btn>
                      {l.uploadId ? (
                        <a href={`/api/accounts/bank-statements/${l.uploadId}/pdf${l.page ? `#page=${l.page}` : ""}`} target="_blank" rel="noreferrer" className="self-center text-[12px] font-semibold text-brand hover:underline">
                          PDF{l.page ? ` p.${l.page}` : ""} ↗
                        </a>
                      ) : null}
                    </>
                  ) : null}
                  {l.flag === "large" ? (
                    <Btn small disabled={busy || !canConfirm} title={t} onClick={() => onMark(l.id)}>
                      Mark…
                    </Btn>
                  ) : l.flag === "dup_ref" || l.flag === "balance" || l.flag === "low_conf" ? null : (
                    <Btn small disabled={busy || !canConfirm} title={t} onClick={() => onMark(l.id)}>
                      Other…
                    </Btn>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------ the panel */

function whatConfirmDoes(c: Candidate, l: LineView): React.ReactNode {
  const [what, who] = c.label.split(" · ");
  const amount = inr(l.debitPaise || l.creditPaise);
  const bills = /against ([^·]+)/.exec(c.sub)?.[1]?.trim();
  switch (c.kind) {
    case "receipt":
      return c.sub.startsWith("Confirmed") ? (
        <>
          <b>Confirm match</b> ties {what} to this bank line. It is already confirmed, so no balance moves.
        </>
      ) : (
        <>
          <b>Confirm match</b> confirms {what.replace(/^Receipt /, "")} as arrived on {dayLabel(l.date)}
          {bills ? `: bill ${bills} is settled` : ""} and {who}&apos;s outstanding drops by {amount}.
        </>
      );
    case "bill":
      return (
        <>
          <b>Confirm match</b> records a confirmed payment of {amount} from {who} against {what.replace(/^Open bill /, "")}.
        </>
      );
    case "payout":
      return (
        <>
          <b>Confirm match</b> marks {what.replace(/^Vendor payout /, "")} paid on {dayLabel(l.date)}
          {l.reference ? ` with reference ${l.reference}` : ""}, and it leaves the Payables calendar.
        </>
      );
    case "txn":
      return (
        <>
          <b>Confirm match</b> ticks {what} on Petty Cash as seen in the bank.
        </>
      );
    case "transfer":
      return (
        <>
          <b>Confirm match</b> enters a transfer {l.debitPaise ? "to" : "from"} {what.replace(/^Transfer (to|from) /, "")} on Petty Cash and matches it.
        </>
      );
    case "charges":
      return (
        <>
          <b>Confirm match</b> enters {amount} of bank charges on Petty Cash and matches it.
        </>
      );
    default:
      return (
        <>
          <b>Confirm match</b> enters {amount} of interest received on Petty Cash and matches it.
        </>
      );
  }
}

function CandidateCard({ c, best, onUse, busy, canConfirm }: { c: Candidate; best?: boolean; onUse?: () => void; busy: boolean; canConfirm: boolean }) {
  return (
    <div className={cx("mt-2 flex items-center gap-2.5 rounded-[10px] border bg-surface px-[11px] py-[9px]", best ? "border-success shadow-[0_0_0_3px_var(--color-success-soft)]" : "border-line")}>
      <div className="min-w-0 flex-1">
        <b className="block text-[12.8px] text-ink">{c.label}</b>
        <div className="text-[11.5px] text-muted">{c.sub}</div>
        <div className="mt-1.5 flex flex-wrap gap-[5px]">
          {c.reasons.map((r) => (
            <span key={r.t} className={cx("rounded-[6px] px-[7px] py-px text-[10.8px] font-[650]", r.ok ? "bg-success-soft text-success" : "bg-divider text-muted")}>
              {r.t}
            </span>
          ))}
        </div>
      </div>
      <div className="flex-none text-right">
        <b className="text-[13px] text-ink tabular-nums">{inr(c.amountPaise)}</b>
        {best ? (
          <div>
            <span className="rounded-[6px] bg-success-soft px-[7px] py-0.5 text-[11px] font-bold text-success">Strong</span>
          </div>
        ) : onUse ? (
          <div className="mt-1">
            <Btn small disabled={busy || !canConfirm} onClick={onUse}>
              Use this
            </Btn>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinePanel({
  d,
  today,
  busy,
  canConfirm,
  canRecord,
  onAccept,
  onDismiss,
  onMark,
  onIgnore,
  onRestore,
  onUndo,
  onEdit,
  onReverse,
  onShort,
}: {
  d: LineDetail;
  today: string;
  busy: boolean;
  canConfirm: boolean;
  canRecord: boolean;
  onAccept: (c: Candidate, via: "suggestion" | "hand") => void;
  onDismiss: (c: Candidate) => void;
  onMark: (as?: string) => void;
  onIgnore: (reason: string) => void;
  onRestore: () => void;
  onUndo: () => void;
  onEdit: () => void;
  onReverse: () => void;
  onShort: () => void;
}) {
  const l = d.line;
  const credit = l.creditPaise > 0;
  const amount = l.debitPaise || l.creditPaise;
  const best = l.state === "suggested" || l.state === "flagged" ? (d.best ?? null) : null;
  const others = d.candidates.filter((c) => c !== best && !(best && c.kind === best.kind && c.id === best.id)).slice(0, 4);
  const t = canConfirm ? undefined : "Matching confirms or records money — that is the Accounts manager's.";
  const open = l.state !== "matched" && l.state !== "ignored";
  void today;
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
      <div className="border-b border-divider px-3.5 py-3">
        <div className={labelCls}>
          Money {credit ? "in" : "out"} · {l.account}
          {l.last4 ? ` ··${l.last4}` : ""}
        </div>
        <div className={cx("mt-0.5 text-[22px] font-[750] tabular-nums", credit ? "text-success" : "text-danger")}>{inr(credit ? amount : -amount, { paise: true, sign: credit })}</div>
        <div className="text-[11.5px] text-muted">
          {dayLabel(l.date, true)}
          {l.balancePaise != null ? ` · balance after ${inr(l.balancePaise, { paise: true })}` : ""}
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="rounded-[8px] border border-divider bg-[#fafbfc] px-2.5 py-2 font-mono text-[11.5px] break-all text-ink">
          {l.description}
          {l.reference ? ` · Ref ${l.reference}` : ""}
        </div>

        {l.state === "flagged" ? (
          <Note tone="w">
            <b>{BANK_FLAGS[l.flag as keyof typeof BANK_FLAGS] ?? "Flagged"}.</b> {l.flagNote}
          </Note>
        ) : null}
        {l.state === "flagged" && (l.flag === "returned" || l.flag === "short") && l.flagReceiptId ? (
          <div className="flex gap-2">
            {l.flag === "returned" ? (
              <Btn tone="danger" className="flex-1" disabled={busy || !canConfirm} title={t} onClick={onReverse}>
                Reverse {l.flagReceiptLabel} — the customer owes it again
              </Btn>
            ) : (
              <Btn tone="ok" className="flex-1" disabled={busy || !canConfirm} title={t} onClick={onShort}>
                Confirm {inr(amount)} — the rest stays owed
              </Btn>
            )}
          </div>
        ) : null}
        {l.state === "flagged" && (l.flag === "balance" || l.flag === "low_conf") ? (
          <Btn disabled={busy || !canRecord} onClick={onEdit}>
            Fix the figure
          </Btn>
        ) : null}

        {l.state === "matched" ? (
          <>
            <div className={labelCls}>Matched to</div>
            {d.matches.map((m) => (
              <div key={m.id} className="flex items-center gap-2.5 rounded-[10px] border border-[#cfe8d9] bg-success-soft px-[11px] py-[9px]">
                <div className="min-w-0 flex-1">
                  <b className="block text-[12.8px] text-ink">{m.label}</b>
                  <div className="text-[11.5px] text-muted">
                    {m.via === "suggestion" ? "Accepted as suggested" : "Matched by hand"}
                    {m.by ? ` by ${m.by}` : ""} · {dayLabel(m.at.slice(0, 10))}, {timeLabel(m.at)}
                  </div>
                </div>
                <b className="text-[13px] text-ink tabular-nums">{inr(m.amountPaise)}</b>
              </div>
            ))}
            <Btn disabled={busy || !canConfirm} title={t} onClick={onUndo}>
              Undo match
            </Btn>
          </>
        ) : null}

        {l.state === "ignored" ? (
          <>
            <Note tone="i">
              <b>Set aside.</b> {l.ignoreReason}
            </Note>
            <Btn disabled={busy || !canRecord} onClick={onRestore}>
              Bring it back
            </Btn>
          </>
        ) : null}

        {open && best ? (
          <>
            <div className={labelCls}>Best match</div>
            <CandidateCard c={best} best busy={busy} canConfirm={canConfirm} />
          </>
        ) : null}
        {open && others.length ? (
          <>
            <div className={labelCls}>{best ? "Also possible" : "Could be"}</div>
            {others.map((c) => (
              <CandidateCard key={`${c.kind}:${c.id}`} c={c} busy={busy} canConfirm={canConfirm} onUse={() => onAccept(c, "hand")} />
            ))}
          </>
        ) : null}
        {open && !best && !others.length ? <Note tone="i">Nothing in MahekOne explains this line yet. Mark it by hand: it creates the record that was missing.</Note> : null}

        {open && best ? (
          <>
            <Note tone="o">{whatConfirmDoes(best, l)}</Note>
            <div className="flex gap-2">
              <Btn tone="ok" className="flex-1" disabled={busy || !canConfirm} title={t} onClick={() => onAccept(best, "suggestion")}>
                ✓ Confirm match
              </Btn>
              <Btn disabled={busy || !canRecord} onClick={() => onDismiss(best)}>
                Not this
              </Btn>
            </div>
          </>
        ) : open && !best ? (
          <Btn tone="primary" disabled={busy || !canConfirm} title={t} onClick={() => onMark()}>
            Mark this line…
          </Btn>
        ) : null}

        {open ? (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            {credit ? (
              <>
                <LinkBtn disabled={!canConfirm} onClick={() => onMark("customer_payment")}>
                  Record as a new customer payment
                </LinkBtn>
                <span className="text-muted">·</span>
                <LinkBtn disabled={!canConfirm} onClick={() => onMark("other_in")}>
                  Mark as other money in
                </LinkBtn>
              </>
            ) : (
              <>
                <LinkBtn disabled={!canConfirm} onClick={() => onMark("vendor_payment")}>
                  Mark as vendor payment…
                </LinkBtn>
                <span className="text-muted">·</span>
                <LinkBtn disabled={!canConfirm} onClick={() => onMark("expense")}>
                  Expense / other money out
                </LinkBtn>
              </>
            )}
            <span className="text-muted">·</span>
            <LinkBtn disabled={!canRecord} onClick={() => onIgnore("")}>
              Ignore
            </LinkBtn>
            {l.state !== "flagged" || (l.flag !== "balance" && l.flag !== "low_conf") ? (
              <>
                <span className="text-muted">·</span>
                <LinkBtn disabled={!canRecord} onClick={onEdit}>
                  Fix a figure
                </LinkBtn>
              </>
            ) : null}
          </div>
        ) : null}

        {d.upload ? (
          <div className="text-[11.5px] text-muted">
            Seen in: {timeLabel(d.upload.at)} upload of {dayLabel(d.upload.at.slice(0, 10))}
            {d.upload.pdfKept ? (
              <>
                {" · "}
                <a href={`/api/accounts/bank-statements/${d.upload.id}/pdf${l.page ? `#page=${l.page}` : ""}`} target="_blank" rel="noreferrer" className="font-semibold text-brand hover:underline">
                  open PDF{l.page ? ` page ${l.page}` : ""} ↗
                </a>
              </>
            ) : (
              " · its PDF has been deleted"
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
