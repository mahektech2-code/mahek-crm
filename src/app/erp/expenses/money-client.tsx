"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, checkboxClass, cx, Tr } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { BodyPortal } from "@/components/ui/body-portal";
import { useEscape } from "@/components/ui/modal";
import type { Result } from "@/lib/result";
import { erpMoneyCancel, erpMoneyImport, erpMoneyMatch, erpMoneyReview, erpMoneySettle } from "@/lib/actions/erp-money";
import { inr } from "@/lib/erp/ui";
import { ErpDialog } from "../_ui/dialog";
import { IconButton, linkClass } from "../_ui/look";
import { boxClass, MField, MoneyFoot, MoneyHead, Note } from "./money-ui";

/* ---------------------------------------------------------------------------
 * The interactive parts of Petty Cash's pages: the filter bar, a row that
 * opens its record, the side drawer, review and settle buttons, and the bank
 * statement's match and import. Every write is a server action that checks
 * the screen and the power again.
 * ------------------------------------------------------------------------- */

/** Sets (or clears) URL parameters, keeping the rest. */
function useParam() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  return (set: Record<string, string | null>, replace = true) => {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(set)) {
      if (v == null || v === "") u.delete(k);
      else u.set(k, v);
    }
    const href = `${path}${u.toString() ? `?${u}` : ""}`;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };
}

export type FilterDef = { name: string; label: string; value: string; options: { v: string; l: string }[] };

/** Period and the list's own filters on the left; the count, the total and Export on the right. */
export function FilterBar({ filters, count, sum, csv, csvName }: { filters: FilterDef[]; count: number; sum?: number | null; csv: string[][]; csvName: string }) {
  const set = useParam();
  const exportCsv = () => {
    const text = csv.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = `${csvName}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-3">
      {filters.map((f) => (
        <select
          key={f.name}
          aria-label={f.label}
          value={f.value}
          onChange={(e) => set({ [f.name]: e.target.value || null, open: null })}
          className={boxClass(false, cx("w-44 cursor-pointer", f.value ? "text-ink" : "text-muted"))}
        >
          {f.options.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
      ))}
      <span className="flex-1" />
      <span className="text-sm text-muted tabular-nums">
        {count} row{count === 1 ? "" : "s"}
        {sum != null ? ` · ${inr(sum)}` : ""}
      </span>
      <Button onClick={exportCsv}>Export</Button>
    </div>
  );
}

/** A table row that opens its record in the drawer. */
export function OpenRow({ id, param = "open", selected, children, className }: { id: string; param?: string; selected?: boolean; children: React.ReactNode; className?: string }) {
  const set = useParam();
  return (
    <Tr onClick={() => set({ [param]: id }, false)} className={cx("cursor-pointer hover:bg-canvas", selected && "bg-brand-soft/60 hover:bg-brand-soft/60", className)}>
      {children}
    </Tr>
  );
}

/** Saves through a server action, says what happened, and refreshes the page. */
function useAct() {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = React.useState(false);
  const act = async (fn: () => Promise<Result<unknown>>, after?: () => void) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) {
        push(r.message ?? "Done");
        after?.();
        router.refresh();
      } else push(r.error, "error");
    } finally {
      setBusy(false);
    }
  };
  return { busy, act };
}

/** Approve, or send back with a reason. */
export function ReviewButtons({ ids, size = "sm" }: { ids: string[]; size?: "sm" | "md" }) {
  const { busy, act } = useAct();
  const [asking, setAsking] = React.useState(false);
  const [why, setWhy] = React.useState("");
  return (
    <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={busy}
        onClick={() => act(() => erpMoneyReview(ids, "approved"))}
        className={cx("cursor-pointer rounded-control bg-success font-semibold text-white hover:opacity-90", size === "sm" ? "h-8 px-3 text-meta" : "h-9 px-4 text-sm")}
      >
        Approve
      </button>
      <button type="button" disabled={busy} onClick={() => setAsking(true)} className={cx("cursor-pointer rounded-control border border-line bg-surface font-semibold text-ink hover:bg-canvas", size === "sm" ? "h-8 px-3 text-meta" : "h-9 px-4 text-sm")}>
        Send back
      </button>
      {asking ? (
        <ErpDialog onClose={() => setAsking(false)} label="Send back" width={520} tall={false}>
          <MoneyHead title="Send back" onClose={() => setAsking(false)} />
          <div className="px-6 py-5">
            <MField label="What needs fixing" req>
              <input autoFocus value={why} onChange={(e) => setWhy(e.target.value)} className={boxClass()} placeholder="e.g. the bill photo is unreadable" />
            </MField>
          </div>
          <MoneyFoot left="They see this on the expense">
            <Button onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || why.trim().length < 3} onClick={() => act(() => erpMoneyReview(ids, "sent_back", why), () => setAsking(false))}>
              Send back
            </Button>
          </MoneyFoot>
        </ErpDialog>
      ) : null}
    </span>
  );
}

/** Cancels a transaction, with the reason. */
export function CancelTxn({ id }: { id: string }) {
  const { busy, act } = useAct();
  const [asking, setAsking] = React.useState(false);
  const [why, setWhy] = React.useState("");
  return (
    <>
      <button type="button" onClick={() => setAsking(true)} className={linkClass("danger", "text-sm font-semibold")}>
        Cancel this transaction
      </button>
      {asking ? (
        <ErpDialog onClose={() => setAsking(false)} label="Cancel transaction" width={520} tall={false}>
          <MoneyHead title="Cancel this transaction" onClose={() => setAsking(false)} />
          <div className="grid gap-3 px-6 py-5">
            <Note tone="warn">It stays on the record, marked cancelled, and counts in no balance.</Note>
            <MField label="Why" req>
              <input autoFocus value={why} onChange={(e) => setWhy(e.target.value)} className={boxClass()} />
            </MField>
          </div>
          <MoneyFoot>
            <Button onClick={() => setAsking(false)}>Keep it</Button>
            <Button variant="danger" disabled={busy || why.trim().length < 3} onClick={() => act(() => erpMoneyCancel(id, why), () => setAsking(false))}>
              Cancel transaction
            </Button>
          </MoneyFoot>
        </ErpDialog>
      ) : null}
    </>
  );
}

/** The side drawer a row opens, over the right of the page. */
export function Drawer({ title, code, children, param = "open" }: { title: string; code?: string; children: React.ReactNode; param?: string }) {
  const set = useParam();
  const close = () => set({ [param]: null });
  useEscape(close, true);
  return (
    <BodyPortal>
      <aside className="animate-fade-in fixed top-0 right-0 bottom-0 z-[55] flex w-[min(420px,100vw)] flex-col border-l border-line bg-surface shadow-pop" aria-label={title}>
        <div className="flex flex-none items-center gap-3 border-b border-line px-6 py-4">
          <div className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
            {title} {code ? <span className="ml-2 font-mono text-meta font-normal text-brand">{code}</span> : null}
          </div>
          <IconButton label="Close" onClick={close}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </aside>
    </BodyPortal>
  );
}

/** Settle an advance: pay back from, or return into, an account. */
export function SettleBox({ advanceId, accounts, verb, disabled, why, defaultAccount }: { advanceId: string; accounts: string[]; verb: string; disabled: boolean; why?: string | null; defaultAccount: string }) {
  const { busy, act } = useAct();
  const [acc, setAcc] = React.useState(defaultAccount);
  return (
    <div className="grid gap-3">
      <select value={acc} onChange={(e) => setAcc(e.target.value)} className={boxClass(false, "cursor-pointer")} disabled={disabled}>
        {accounts.map((a) => (
          <option key={a}>{a}</option>
        ))}
      </select>
      <SettleNote />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => act(() => erpMoneySettle(advanceId, acc))}
        className={cx("h-10 rounded-control px-5 text-left text-sm font-semibold text-white", disabled ? "cursor-not-allowed bg-brand/45" : "cursor-pointer bg-brand hover:bg-brand-hover")}
      >
        {verb}
      </button>
      {why ? <div className="text-sm text-muted">{why}</div> : null}
    </div>
  );
}

function SettleNote() {
  return (
    <p className="text-sm leading-6 text-muted">
      Unspent instead? The same step records <b className="text-body">cash returned</b> to the account — a transfer back, with its own TXN.
    </p>
  );
}

/** Match a bank line to one transaction. */
export function MatchButton({ lineId, txnId, primary }: { lineId: string; txnId: string; primary?: boolean }) {
  const { busy, act } = useAct();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        act(() => erpMoneyMatch(lineId, [txnId]));
      }}
      className={cx("h-10 flex-none cursor-pointer rounded-control px-4 text-sm font-semibold", primary ? "bg-brand text-white hover:bg-brand-hover" : "border border-line bg-surface text-ink hover:bg-canvas")}
    >
      Match
    </button>
  );
}

export function MatchLink({ lineId, txnId, label = "Match" }: { lineId: string; txnId: string; label?: string }) {
  const { busy, act } = useAct();
  return (
    <button type="button" disabled={busy} onClick={() => act(() => erpMoneyMatch(lineId, [txnId]))} className={linkClass("brand", "text-sm font-semibold")}>
      {label}
    </button>
  );
}

/** Split one bank line across several transactions — they must add up to it. */
export function SplitLink({ lineId, amount, options }: { lineId: string; amount: number; options: { id: string; label: string; left: number }[] }) {
  const { busy, act } = useAct();
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const sum = options.filter((o) => picked.has(o.id)).reduce((s, o) => s + o.left, 0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={linkClass("brand", "font-semibold")}>
        Split across transactions
      </button>
      {open ? (
        <ErpDialog onClose={() => setOpen(false)} label="Split" width={640} tall={false}>
          <MoneyHead title="Split across transactions" onClose={() => setOpen(false)} />
          <div className="grid gap-2 px-6 py-5">
            {options.length ? (
              options.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-center gap-3 rounded-control border border-line px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={picked.has(o.id)}
                    onChange={() => {
                      const s = new Set(picked);
                      if (s.has(o.id)) s.delete(o.id);
                      else s.add(o.id);
                      setPicked(s);
                    }}
                  />
                  <span className="flex-1">{o.label}</span>
                  <span className="font-semibold tabular-nums">{inr(o.left)}</span>
                </label>
              ))
            ) : (
              <div className="text-sm text-muted">No transactions near this line to split it across.</div>
            )}
          </div>
          <MoneyFoot left={`${inr(sum)} of ${inr(amount)}`}>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || sum !== amount} onClick={() => act(() => erpMoneyMatch(lineId, [...picked]), () => setOpen(false))}>
              Match all
            </Button>
          </MoneyFoot>
        </ErpDialog>
      ) : null}
    </>
  );
}

/** Import a bank's statement: paste its CSV, or choose the file. */
export function ImportStatement({ accounts, current }: { accounts: string[]; current: string }) {
  const { busy, act } = useAct();
  const [open, setOpen] = React.useState(false);
  const [acc, setAcc] = React.useState(current);
  const [text, setText] = React.useState("");
  return (
    <>
      <Button onClick={() => setOpen(true)}>⬆ Import statement</Button>
      {open ? (
        <ErpDialog onClose={() => setOpen(false)} label="Import statement" width={760} tall={false}>
          <MoneyHead title="Import statement" onClose={() => setOpen(false)} />
          <div className="grid gap-4 px-6 py-5">
            <MField label="Account" req>
              <select value={acc} onChange={(e) => setAcc(e.target.value)} className={boxClass(false, "cursor-pointer")}>
                {accounts.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </MField>
            <MField label="The bank's CSV" req hint="Choose the file the bank gives you, or paste its rows. A line already imported is skipped.">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setText(await f.text());
                }}
                className="mb-2 text-sm"
              />
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className={boxClass(false, "h-auto py-2 font-mono text-sm")} />
            </MField>
          </div>
          <MoneyFoot left="Lines with one exact match are matched as they land">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !text.trim()} onClick={() => act(() => erpMoneyImport(acc, text), () => setOpen(false))}>
              Import
            </Button>
          </MoneyFoot>
        </ErpDialog>
      ) : null}
    </>
  );
}

export { Link };
