"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { bankSaveAccount } from "@/lib/actions/bank-statements";
import type { BankAccountView, HomeView, UploadRow } from "@/lib/services/bank-statement-service";
import { Acc, BankBadge, Btn, Dialog, FieldLabel, inputCls, inr, Note, Pill, Ret, retention, TabCount, tabCls, timeLabel, whenLabel } from "./bank-ui";
import { UploadFlow, type UploadAccount } from "./upload-flow";

/* ---------------------------------------------------------------------------
 * ACCOUNTS → BANK STATEMENT MANAGEMENT → BANK ACCOUNTS & UPLOADS.
 *
 * One card per bank account — its balance as the bank printed it, and how
 * much of it is matched, unmatched and flagged — the four figures that say
 * how much is left to explain, and today's uploads. Drawn as the mockups.
 * ------------------------------------------------------------------------- */

export function HomeScreen({
  view,
  today,
  retentionDays,
  maxPdfMb,
  allAccounts,
  canRecord,
  canConfirm,
  openUpload,
  startUpload,
}: {
  view: HomeView;
  today: string;
  retentionDays: number;
  maxPdfMb: number;
  allAccounts: { id: string; name: string; bankName: string | null; last4: string | null; accountType: string | null; active: boolean }[];
  canRecord: boolean;
  canConfirm: boolean;
  openUpload: string | null;
  startUpload: boolean;
}) {
  const router = useRouter();
  const [upload, setUpload] = React.useState<{ id: string | null; n: number } | null>(openUpload ? { id: openUpload, n: 0 } : startUpload ? { id: null, n: 0 } : null);
  const [accountsOpen, setAccountsOpen] = React.useState(false);
  const [tab, setTab] = React.useState<"today" | "review">(view.today.length || !view.review.length ? "today" : "review");
  const k = view.kpis;
  const uploadAccounts: UploadAccount[] = view.accounts.map((a) => ({ id: a.id, name: a.name, last4: a.last4, accountType: a.accountType, mark: a.mark, lastUploadAt: a.lastUploadAt }));
  const rows = tab === "today" ? view.today : view.review;

  return (
    <div className="px-6 pt-5 pb-12">
      <div className="mb-3.5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-heading">Bank statement management</h1>
          <div className="mt-0.5 text-[12.5px] text-muted">Upload the bank&apos;s PDF whenever you have one. Only new lines are added.</div>
        </div>
        <Link href="/accounts/bank-uploads" className="ml-auto inline-flex h-[34px] items-center rounded-[9px] border border-line bg-surface px-3.5 text-[13px] font-[650] text-ink no-underline hover:bg-canvas hover:no-underline">
          Upload history
        </Link>
        <Btn onClick={() => setAccountsOpen(true)}>Bank accounts</Btn>
        <Btn tone="primary" onClick={() => setUpload({ id: null, n: (upload?.n ?? 0) + 1 })}>
          ⤒ Upload bank PDF
        </Btn>
      </div>

      {view.accounts.length ? (
        <div className="mb-3.5 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(4, Math.max(view.accounts.length, 2))}, minmax(0, 1fr))` }}>
          {view.accounts.map((a) => (
            <BankCard key={a.id} a={a} today={today} />
          ))}
        </div>
      ) : (
        <Note tone="w" className="mb-3.5">
          No bank account is set up yet. Add the accounts you bank with under <b>Bank accounts</b>, then upload their statements.
        </Note>
      )}

      <div className="mb-3.5 grid grid-cols-4 gap-3">
        <Kpi l="Unmatched credits" v={`${k.creditsN} · ${inr(k.creditsPaise)}`} s="money in nobody has explained" href="/accounts/bank-reconcile?tab=unmatched&dir=in" />
        <Kpi l="Unmatched debits" v={`${k.debitsN} · ${inr(k.debitsPaise)}`} s="money out with no record" href="/accounts/bank-reconcile?tab=unmatched&dir=out" />
        <Kpi l="Flagged" v={String(k.flagged)} s="duplicates, returns, mismatches" href="/accounts/bank-reconcile?tab=flagged" />
        <Kpi l="Matched this week" v={String(k.matchedWeek)} s={k.viaSuggestionPct == null ? "lines explained in the last 7 days" : `${k.viaSuggestionPct}% matched by suggestion`} href="/accounts/bank-reconcile?tab=matched&period=7" />
      </div>

      <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
        <div className="flex gap-0.5 border-b border-line bg-surface px-3">
          <button type="button" className={tabCls(tab === "today")} onClick={() => setTab("today")}>
            Today&apos;s uploads<TabCount on={tab === "today"}>{view.today.length}</TabCount>
          </button>
          <button type="button" className={tabCls(tab === "review")} onClick={() => setTab("review")}>
            Needs review<TabCount on={tab === "review"}>{view.review.length}</TabCount>
          </button>
        </div>
        <UploadTable rows={rows} today={today} onOpen={(u) => (u.status === "imported" ? router.push(`/accounts/bank-reconcile?upload=${u.id}&tab=all`) : setUpload({ id: u.id, n: (upload?.n ?? 0) + 1 }))} empty={tab === "today" ? "Nothing uploaded today. Upload the bank's PDF whenever you download one." : "Nothing waiting. Every upload is read and imported."} />
      </div>

      {upload ? (
        <UploadFlow
          key={`${upload.id ?? "new"}-${upload.n}`}
          open
          onClose={() => {
            setUpload(null);
            router.refresh();
          }}
          accounts={uploadAccounts}
          today={today}
          retentionDays={retentionDays}
          maxPdfMb={maxPdfMb}
          initial={upload.id}
          lastLabel={(at) => (at ? whenLabel(at, today).replace(/^Today /, "").replace(/^Yesterday .*/, "yesterday") : "never")}
          canRecord={canRecord}
        />
      ) : null}
      {accountsOpen ? <AccountsDialog accounts={allAccounts} canEdit={canConfirm} onClose={() => setAccountsOpen(false)} /> : null}
    </div>
  );
}

function BankCard({ a, today }: { a: BankAccountView; today: string }) {
  const total = a.matched + a.unmatched + a.flagged;
  const w = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  return (
    <Link
      href={`/accounts/bank-reconcile?account=${a.id}`}
      className="flex flex-col gap-2 rounded-[12px] border border-line bg-surface px-3.5 py-3 text-body no-underline hover:border-brand hover:no-underline"
    >
      <div className="flex items-center gap-[9px]">
        <BankBadge mark={a.mark} size={30} />
        <div className="min-w-0">
          <b className="block truncate text-[13.5px] text-ink">{a.bankName ?? a.name}</b>
          <small className="text-[11.5px] text-muted">
            {a.accountType ?? "Account"} {a.last4 ? `··${a.last4}` : ""}
          </small>
        </div>
        {a.toDo ? (
          <span className="ml-auto inline-grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-danger px-[5px] text-[10.5px] font-bold text-white">{a.toDo}</span>
        ) : (
          <Pill tone="ok" className="ml-auto">
            Clear
          </Pill>
        )}
      </div>
      <div>
        <div className="text-[11.5px] text-muted">Balance per bank</div>
        <div className="text-[19px] font-[750] text-heading tabular-nums">{a.balancePaise == null ? "—" : inr(a.balancePaise)}</div>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-divider">
        <span className="h-full bg-success" style={{ width: w(a.matched) }} />
        <span className="h-full bg-danger" style={{ width: w(a.unmatched) }} />
        <span className="h-full bg-[#e08a2c]" style={{ width: w(a.flagged) }} />
      </div>
      <div className="flex justify-between text-[11.8px] text-muted">
        <span>
          <b className="font-[650] text-ink">{a.matched}</b> matched
        </span>
        <span>
          <b className="font-[650] text-ink">{a.unmatched}</b> unmatched
        </span>
        <span>
          <b className="font-[650] text-ink">{a.flagged}</b> flagged
        </span>
      </div>
      <div className="text-[11.8px] text-muted">Last upload {whenLabel(a.lastUploadAt, today)}</div>
    </Link>
  );
}

function Kpi({ l, v, s, href }: { l: string; v: string; s: string; href: string }) {
  return (
    <Link href={href} className="rounded-[12px] border border-line bg-surface px-3.5 py-3 text-body no-underline hover:border-brand hover:no-underline">
      <div className="text-[11.5px] font-semibold text-muted">{l}</div>
      <div className="mt-0.5 text-[21px] font-[750] text-heading tabular-nums">{v}</div>
      <div className="text-[11.5px] text-muted">{s}</div>
    </Link>
  );
}

export function UploadTable({ rows, today, onOpen, empty }: { rows: UploadRow[]; today: string; onOpen: (u: UploadRow) => void; empty: string }) {
  const th = "border-b border-line bg-[#fafbfc] px-3 py-[9px] text-left text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-muted uppercase";
  const td = "border-b border-divider px-3 py-2.5 text-[12.8px] whitespace-nowrap text-body";
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={th}>Uploaded</th>
          <th className={th}>Account</th>
          <th className={th}>Statement period</th>
          <th className={cx(th, "text-right")}>Lines read</th>
          <th className={cx(th, "text-right")}>New</th>
          <th className={cx(th, "text-right")}>Already in</th>
          <th className={th}>Balance check</th>
          <th className={th}>Matched</th>
          <th className={th}>PDF</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((u) => {
          const ret = retention(u, today);
          const flag = u.status === "failed" || u.balanceOk === false;
          return (
            <tr key={u.id} onClick={() => onOpen(u)} className={cx("cursor-pointer hover:bg-[#fbfaff]", flag && "bg-[#fffaf3]")}>
              <td className={td}>
                <b className="font-[650] text-ink">{timeLabel(u.uploadedAt)}</b> <span className="text-[11.5px] text-muted">{u.uploadedBy ?? ""}</span>
              </td>
              <td className={td}>
                <Acc mark={u.mark} name={u.account} last4={u.last4} />
              </td>
              <td className={td}>{u.periodFrom ? `${u.periodFrom} – ${u.periodTo ?? "…"}` : <span className="text-muted">{u.fileName}</span>}</td>
              <td className={cx(td, "text-right tabular-nums")}>{u.status === "reading" ? "…" : u.read}</td>
              <td className={cx(td, "text-right tabular-nums")}>
                <b className="font-[650] text-ink">{u.status === "imported" ? u.imported : u.status === "reading" ? "…" : u.fresh}</b>
              </td>
              <td className={cx(td, "text-right tabular-nums")}>{u.status === "reading" ? "…" : u.existing}</td>
              <td className={td}>
                {u.status === "reading" ? (
                  <Pill tone="ai">Reading…</Pill>
                ) : u.status === "failed" ? (
                  <Pill tone="danger">Could not read</Pill>
                ) : u.status === "discarded" ? (
                  <Pill tone="muted">Discarded</Pill>
                ) : u.balanceOk ? (
                  <Pill tone="ok">Agrees</Pill>
                ) : (
                  <Pill tone="flag">Breaks at line {u.breakAt ?? "?"}</Pill>
                )}
              </td>
              <td className={td}>
                {u.status === "imported" ? (
                  u.imported === 0 ? (
                    <span className="text-[11.5px] text-muted">nothing new</span>
                  ) : (
                    <Pill tone={u.matched >= u.imported ? "ok" : "info"}>
                      {u.matched} of {u.imported}
                    </Pill>
                  )
                ) : u.status === "ready" ? (
                  <Pill tone="brand">To import</Pill>
                ) : (
                  <span className="text-[11.5px] text-muted">—</span>
                )}
              </td>
              <td className={td}>
                <Ret tone={ret.tone}>{ret.text}</Ret>
              </td>
            </tr>
          );
        })}
        {!rows.length ? (
          <tr>
            <td colSpan={9} className="px-3 py-10 text-center text-[12.5px] text-muted">
              {empty}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

/* --------------------------------------------------------------- accounts */

function AccountsDialog({
  accounts,
  canEdit,
  onClose,
}: {
  accounts: { id: string; name: string; bankName: string | null; last4: string | null; accountType: string | null; active: boolean }[];
  canEdit: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const blank = { id: null as string | null, name: "", bankName: "", last4: "", accountType: "Current", active: true };
  const [form, setForm] = React.useState<typeof blank | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function save() {
    if (!form) return;
    setBusy(true);
    const r = await toast.run(bankSaveAccount({ ...form, bankName: form.bankName || null, last4: form.last4 || null, accountType: form.accountType || null }));
    setBusy(false);
    if (r.ok) {
      setForm(null);
      router.refresh();
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Bank accounts"
      width={720}
      top={100}
      foot={
        form ? (
          <>
            <Btn className="ml-auto" onClick={() => setForm(null)}>
              Cancel
            </Btn>
            <Btn tone="primary" disabled={busy || !form.name.trim()} onClick={save}>
              {form.id ? "Save account" : "Add account"}
            </Btn>
          </>
        ) : (
          <>
            <span className="text-[11.5px] text-muted">The same accounts Petty Cash keeps its statements for.</span>
            <Btn tone="primary" className="ml-auto" disabled={!canEdit} title={canEdit ? undefined : "Setting up accounts is the Accounts manager's."} onClick={() => setForm(blank)}>
              + Add bank account
            </Btn>
          </>
        )
      }
    >
      <div className="px-5 py-4">
        {form ? (
          <div className="grid grid-cols-2 gap-x-3.5 gap-y-3">
            <div>
              <FieldLabel required>Name</FieldLabel>
              <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. HDFC Bank" />
            </div>
            <div>
              <FieldLabel>Bank, as its statements name it</FieldLabel>
              <input className={inputCls} value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} placeholder="e.g. HDFC Bank" />
            </div>
            <div>
              <FieldLabel>Last four digits</FieldLabel>
              <input className={inputCls} value={form.last4} inputMode="numeric" maxLength={4} onChange={(e) => setForm({ ...form, last4: e.target.value.replace(/\D/g, "") })} placeholder="1186" />
            </div>
            <div>
              <FieldLabel>Type</FieldLabel>
              <select className={inputCls} value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })}>
                {["Current", "OD", "CC", "Savings"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            {form.id ? (
              <label className="col-span-2 flex items-center gap-2 text-[12.5px] text-body">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> In use — untick to stop offering it for uploads
              </label>
            ) : null}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {["Account", "Bank", "Number", "Type", ""].map((h) => (
                  <th key={h} className="border-b border-line bg-[#fafbfc] px-3 py-[9px] text-left text-[11px] font-bold tracking-[0.06em] text-muted uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className={cx(!a.active && "text-faint")}>
                  <td className="border-b border-divider px-3 py-2.5 text-[12.8px]">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-ink">{a.name}</span>
                    {!a.active ? <span className="ml-2 text-[11px] text-muted">not in use</span> : null}
                  </td>
                  <td className="border-b border-divider px-3 py-2.5 text-[12.8px]">{a.bankName ?? "—"}</td>
                  <td className="border-b border-divider px-3 py-2.5 text-[12.8px]">{a.last4 ? `··${a.last4}` : "—"}</td>
                  <td className="border-b border-divider px-3 py-2.5 text-[12.8px]">{a.accountType ?? "—"}</td>
                  <td className="border-b border-divider px-3 py-2.5 text-right">
                    {canEdit ? (
                      <Btn small onClick={() => setForm({ id: a.id, name: a.name, bankName: a.bankName ?? "", last4: a.last4 ?? "", accountType: a.accountType ?? "Current", active: a.active })}>
                        Edit
                      </Btn>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
