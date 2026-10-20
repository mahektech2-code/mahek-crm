import Link from "next/link";
import { Icon } from "@/components/shell/icons";
import { Card, cx, Td, Th, Tr } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { fd, fdLong, inr, nf } from "@/lib/erp/ui";
import { erpLink } from "@/lib/erp/registry";
import { MONEY_KIND_LABEL } from "@/lib/erp/engines/money";
import type { AdvanceRow, TxnRow } from "@/lib/erp/money";
import type { bankView, statementView, TxnDetail } from "@/lib/erp/money-views";
import { CancelTxn, Drawer, FilterBar, ImportStatement, MatchButton, MatchLink, OpenRow, ReviewButtons, SettleBox, SplitLink, type FilterDef } from "./money-client";
import { AccountMark, labelClass, Note, Pill, SumStrip, Timeline, type KitAccount } from "./money-ui";

/* ---------------------------------------------------------------------------
 * PETTY CASH'S PAGES, drawn as docs/erp/money-flow draws them: the four
 * sub-modules across the top with their icons and counts, a card holding the
 * sub-tabs and the list under them, and the record a row opens in a drawer at
 * the right. Server components; the interactive bits are money-client.tsx.
 * ------------------------------------------------------------------------- */

export type Tab = { key: string; label: string; href: string; active: boolean; count?: number };

const SECTION_ICON: Record<string, string> = { Overview: "dashboard", Expenses: "rupee", Receipts: "doc", "Cash & Bank": "wallet" };

/** The four sub-modules: an icon, the name, and a count pill — filled when it is the one you are on. */
export function SectionNav({ sections }: { sections: Tab[] }) {
  return (
    <nav aria-label="Petty Cash sections" className="mb-5 flex flex-wrap items-center gap-2 border-b border-line">
      {sections.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx(
            "-mb-px flex items-center gap-2.5 border-b-2 px-4 pt-2 pb-3 text-md whitespace-nowrap",
            t.active ? "border-brand font-semibold text-brand-hover" : "border-transparent font-medium text-muted hover:text-body",
          )}
        >
          <span className={cx("flex h-5 w-5 items-center justify-center rounded-[5px] border", t.active ? "border-brand bg-brand-soft" : "border-line")}>
            <Icon name={SECTION_ICON[t.label] ?? "grid"} size={13} />
          </span>
          {t.label}
          {t.count ? <span className={cx("rounded-full px-2 text-xs leading-5 font-semibold tabular-nums", t.active ? "bg-brand text-white" : "bg-divider text-body")}>{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** The sub-tabs, across the top of the card they belong to. */
export function SubTabs({ tabs, aside }: { tabs: Tab[]; aside?: React.ReactNode }) {
  return (
    <nav aria-label="Petty Cash tabs" className="flex flex-wrap items-center gap-1 border-b border-line px-3">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx(
            "-mb-px flex items-center gap-2 border-b-2 px-4 py-3.5 text-sm whitespace-nowrap",
            t.active ? "border-brand font-semibold text-brand-hover" : "border-transparent font-medium text-muted hover:text-body",
          )}
        >
          {t.label}
          {t.count != null && t.count > 0 ? <span className="rounded-full bg-divider px-2 text-xs leading-5 font-semibold text-body tabular-nums">{nf(t.count)}</span> : null}
        </Link>
      ))}
      <span className="flex-1" />
      {aside}
    </nav>
  );
}

export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("overflow-hidden rounded-card border border-line bg-surface", className)}>{children}</div>;
}

/* ----------------------------------------------------------------- cells */

const short = (name: string | null) => (name ? name.split(" ")[0] : "—");

function accountKind(k: string | null): KitAccount["kind"] {
  return k === "bank" ? "bank" : k === "petty" ? "petty" : "cash";
}

/** "K Kotak · NEFT" — the account the money left, and how. */
export function PaidFromCell({ t, accounts }: { t: TxnRow; accounts: KitAccount[] }) {
  if (t.advanceId && !t.from) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-brand text-2xs font-bold text-white">A</span>
        <span className="font-medium text-ink">Advance · {t.advanceEmployee}</span>
      </span>
    );
  }
  const kind = accountKind(t.fromKind);
  const acc = accounts.find((a) => a.id === t.fromAccountId);
  const how = kind === "bank" ? (t.mode === "Cheque" ? `cheque ${t.reference ?? ""}`.trim() : t.mode) : null;
  return (
    <span className="inline-flex items-center gap-2">
      <AccountMark kind={kind} name={t.from ?? "?"} size="sm" index={acc ? accounts.filter((a) => a.kind === "bank").findIndex((a) => a.id === acc.id) : 0} />
      <span className="font-medium text-ink">
        {kind === "bank" ? short(t.from) : t.from}
        {how ? ` · ${how}` : ""}
        {t.sourceLabel ? <span className="text-muted"> · from {t.sourceLabel}</span> : null}
      </span>
    </span>
  );
}

function IntoCell({ t, accounts }: { t: TxnRow; accounts: KitAccount[] }) {
  const kind = accountKind(t.toKind);
  const i = accounts.filter((a) => a.kind === "bank").findIndex((a) => a.id === t.toAccountId);
  return (
    <span className="inline-flex items-center gap-2">
      <AccountMark kind={kind} name={t.to ?? "?"} size="sm" index={Math.max(0, i)} />
      <span className="font-medium text-ink">{t.to}</span>
    </span>
  );
}

/** Whether the bank's statement has the money: matched, not yet, or there is no bank side. */
export function BankMatch({ t, dup }: { t: TxnRow; dup?: boolean }) {
  if (t.status === "cancelled") return <Pill tone="muted">Cancelled</Pill>;
  if (dup) return <Pill tone="danger">Duplicate?</Pill>;
  const bankLegs = (t.fromKind === "bank" ? 1 : 0) + (t.toKind === "bank" ? 1 : 0);
  if (!bankLegs) return <span className="text-sm text-muted">{t.kind === "transfer" ? "No bank side" : "Cash — none"}</span>;
  const need = t.amountPaise * bankLegs;
  if (t.matchedPaise >= need) return <Pill tone="info">{bankLegs > 1 ? "Both legs matched" : "Matched"}</Pill>;
  if (t.matchedPaise > 0) return <Pill tone="warn">{bankLegs > 1 ? "One leg matched" : "Part matched"}</Pill>;
  return <Pill tone="warn">Not matched</Pill>;
}

export function ReviewPill({ t }: { t: TxnRow }) {
  if (t.status === "cancelled") return <Pill tone="muted">Cancelled</Pill>;
  if (t.review === "to_review") return <Pill tone="brand">To review</Pill>;
  if (t.review === "sent_back") return <Pill tone="danger">Sent back</Pill>;
  if (t.review === "approved") return <Pill tone="success">Approved</Pill>;
  return <Pill tone="success">Paid</Pill>;
}

/** An audit code as the drawer's history line says it. */
function historyWord(action: string): string {
  if (action.endsWith(".create") || action.endsWith(".give")) return "created";
  if (action.endsWith(".edit")) return "edited";
  if (action === "erp.money.approve") return "approved";
  if (action === "erp.money.sendBack") return "sent back";
  if (action.endsWith(".cancel")) return "cancelled";
  if (action.endsWith(".match")) return "matched to the bank";
  if (action.endsWith(".unmatch")) return "unmatched";
  if (action.endsWith(".bills")) return "bills submitted";
  if (action.endsWith(".settle")) return "settled";
  return action.split(".").pop() ?? action;
}

const TxnId = ({ t }: { t: TxnRow }) => <span className="font-mono text-sm text-brand">{t.label}</span>;

/* ------------------------------------------------------------------ lists */

export type ListKind = "paid" | "petty" | "review" | "cancelled" | "all" | "receipts" | "transfers";

export function TxnTable({
  kind,
  rows,
  accounts,
  approver,
  openId,
  filters,
  total,
  sum,
  capped,
  empty,
}: {
  kind: ListKind;
  rows: (TxnRow & { dup: boolean })[];
  accounts: KitAccount[];
  approver: boolean;
  openId: string | null;
  filters: FilterDef[];
  total: number;
  sum: number;
  capped: boolean;
  empty: string;
}) {
  const H = (l: string, align?: "right", w?: string) => ({ l, align, w });
  const head =
    kind === "receipts"
      ? [H("TXN ID", undefined, "w-40"), H("Date", undefined, "w-24"), H("Received from"), H("Into"), H("Mode / ref"), H("Applied to"), H("Amount", "right"), H("Bank match")]
      : kind === "transfers"
        ? [H("TXN ID", undefined, "w-40"), H("Date", undefined, "w-24"), H("From → To"), H("Slip / ref"), H("Amount", "right"), H("Bank match")]
        : kind === "review"
          ? [H("TXN ID", undefined, "w-40"), H("Date", undefined, "w-24"), H("Category"), H("Paid to"), H("Paid from"), H("Amount", "right"), H("Submitted by"), H("")]
          : kind === "cancelled"
            ? [H("TXN ID", undefined, "w-40"), H("Date", undefined, "w-24"), H("Type"), H("Party"), H("Amount", "right"), H("Why")]
            : kind === "petty"
              ? [H("TXN ID", undefined, "w-40"), H("Date", undefined, "w-24"), H("Category"), H("Paid to"), H("Bill no."), H("Amount", "right"), H("Paid from"), H("Status")]
              : [H("TXN ID", undefined, "w-40"), H("Date", undefined, "w-24"), H("Category"), H("Vendor / payee"), H("Invoice no."), H("Amount", "right"), H("Paid from"), H("Bank match")];
  const csv = [head.map((h) => h.l).filter(Boolean), ...rows.map((t) => [t.label, t.date, t.category ?? "", t.payee ?? t.customer ?? t.payer ?? "", t.invoiceNo ?? t.reference ?? "", String(t.amountPaise / 100), t.from ?? t.to ?? ""])];
  return (
    <>
      <FilterBar filters={filters} count={total} sum={sum} csv={csv} csvName={`petty-cash-${kind}`} />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <Tr>
              {head.map((h, i) => (
                <Th key={i} align={h.align} className={cx("bg-surface", h.w)}>
                  {h.l}
                </Th>
              ))}
            </Tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <OpenRow key={t.id} id={t.id} selected={t.id === openId} className="text-sm [&>td]:h-11 [&>td]:text-sm">
                <Td>
                  <TxnId t={t} />
                </Td>
                <Td>{fd(t.date)}</Td>
                {kind === "receipts" ? (
                  <>
                    <Td className="font-semibold text-ink">{t.customer ?? t.payer ?? "—"}</Td>
                    <Td>
                      <IntoCell t={t} accounts={accounts} />
                    </Td>
                    <Td className="text-muted">{t.toKind === "bank" ? [t.mode, t.reference].filter(Boolean).join(" · ") : "Cash"}</Td>
                    <Td className="max-w-64 truncate text-muted" title={t.billsText ?? undefined}>
                      {t.billsText ?? "—"}
                    </Td>
                    <Td align="right" className="font-bold text-ink">
                      {inr(t.amountPaise)}
                    </Td>
                    <Td>
                      <BankMatch t={t} />
                    </Td>
                  </>
                ) : kind === "transfers" ? (
                  <>
                    <Td>
                      <span className="inline-flex items-center gap-2 font-medium text-ink">
                        <AccountMark kind={accountKind(t.fromKind)} name={t.from ?? "?"} size="sm" index={accounts.filter((a) => a.kind === "bank").findIndex((a) => a.id === t.fromAccountId)} />
                        {t.from} <span className="text-brand">→</span>
                        <AccountMark kind={accountKind(t.toKind)} name={t.to ?? "?"} size="sm" index={accounts.filter((a) => a.kind === "bank").findIndex((a) => a.id === t.toAccountId)} />
                        {t.to}
                      </span>
                    </Td>
                    <Td className="text-muted">{t.reference ?? "—"}</Td>
                    <Td align="right" className="font-bold text-ink">
                      {inr(t.amountPaise)}
                    </Td>
                    <Td>
                      <BankMatch t={t} />
                    </Td>
                  </>
                ) : kind === "review" ? (
                  <>
                    <Td>{t.category}</Td>
                    <Td className="font-semibold text-ink">{t.payee ?? "—"}</Td>
                    <Td>
                      <PaidFromCell t={t} accounts={accounts} />
                    </Td>
                    <Td align="right" className="font-bold text-ink">
                      {inr(t.amountPaise)}
                    </Td>
                    <Td className="text-muted">{t.by ?? "—"}</Td>
                    <Td align="right">{approver && t.review === "to_review" ? <ReviewButtons ids={[t.id]} /> : <ReviewPill t={t} />}</Td>
                  </>
                ) : kind === "cancelled" ? (
                  <>
                    <Td>{MONEY_KIND_LABEL[t.kind]}</Td>
                    <Td className="font-semibold text-ink">{t.payee ?? t.customer ?? t.payer ?? t.advanceEmployee ?? "—"}</Td>
                    <Td align="right" className="font-bold text-muted line-through">
                      {inr(t.amountPaise)}
                    </Td>
                    <Td className="max-w-80 truncate text-muted" title={t.cancelReason ?? undefined}>
                      {t.cancelReason}
                    </Td>
                  </>
                ) : (
                  <>
                    <Td>{t.category}</Td>
                    <Td className="font-semibold text-ink">{t.payee ?? "—"}</Td>
                    <Td className="text-body">{t.invoiceNo ?? (t.noBillReason ? <span className="text-muted">no bill</span> : "—")}</Td>
                    <Td align="right" className="font-bold text-ink">
                      {inr(t.amountPaise)}
                    </Td>
                    <Td>
                      <PaidFromCell t={t} accounts={accounts} />
                    </Td>
                    <Td>{kind === "petty" ? <ReviewPill t={t} /> : kind === "all" && t.status === "cancelled" ? <ReviewPill t={t} /> : <BankMatch t={t} dup={t.dup} />}</Td>
                  </>
                )}
              </OpenRow>
            ))}
          </tbody>
        </table>
        {!rows.length ? <div className="px-5 py-10 text-center text-sm text-muted">{empty}</div> : null}
        {capped ? <div className="border-t border-divider px-5 py-3 text-sm text-muted">Showing the newest {rows.length} of {nf(total)}. Narrow the period or a filter to see the rest.</div> : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ drawer */

export function TxnDrawerView({ d, accounts, approver, canWrite }: { d: TxnDetail; accounts: KitAccount[]; approver: boolean; canWrite: boolean }) {
  const t = d.t;
  const title = t.kind === "receipt" ? (t.toKind === "bank" ? "Bank receipt" : "Cash receipt") : t.kind === "expense" ? (t.petty || t.advanceId ? "Petty cash expense" : "Expense") : MONEY_KIND_LABEL[t.kind];
  const party = t.kind === "receipt" ? (t.customer ?? t.payer) : t.kind === "transfer" ? `${t.from} → ${t.to}` : (t.payee ?? t.advanceEmployee);
  const cashReceipt = t.kind === "receipt" && t.toKind !== "bank";
  const used = d.uses.filter((u) => u.status === "active").reduce((s, u) => s + u.amountPaise, 0);
  const first = d.history[0];
  return (
    <Drawer title={title} code={t.label}>
      <div className="grid gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <span className={cx("text-2xl font-bold tabular-nums", t.status === "cancelled" ? "text-muted line-through" : "text-ink")}>{inr(t.amountPaise)}</span>
            {t.kind === "receipt" ? t.status === "active" ? <Pill tone="success">Received</Pill> : <Pill tone="muted">Cancelled</Pill> : t.kind === "expense" ? <ReviewPill t={t} /> : <BankMatch t={t} />}
          </div>
          <div className="mt-1 text-sm text-muted">
            {party ? (
              <>
                {t.kind === "receipt" ? "from " : t.kind === "expense" ? "to " : ""}
                <b className="text-ink">{party}</b> ·{" "}
              </>
            ) : null}
            {fdLong(t.date)}
            {t.reference ? ` · ${t.reference}` : ""}
            {t.invoiceNo ? ` · ${t.invoiceNo}` : ""}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          {d.balanceAfter != null ? (
            <div>
              <div className="text-sm text-muted">{t.kind === "receipt" ? `${short(t.to)} balance after` : `${short(t.from ?? t.to)} balance after`}</div>
              <div className="font-semibold text-ink tabular-nums">{inr(d.balanceAfter)}</div>
            </div>
          ) : null}
          {t.kind === "receipt" ? (
            <div>
              <div className="text-sm text-muted">Applied to</div>
              <div className="font-semibold text-ink">{t.billsText ?? "On account"}</div>
            </div>
          ) : null}
          {t.kind === "expense" ? (
            <>
              <div>
                <div className="text-sm text-muted">Category</div>
                <div className="font-semibold text-ink">{t.category ?? "—"}</div>
              </div>
              <div>
                <div className="text-sm text-muted">Paid from</div>
                <div className="font-semibold text-ink">
                  <PaidFromCell t={t} accounts={accounts} />
                </div>
              </div>
              <div className="col-span-2">
                <div className="text-sm text-muted">Purpose</div>
                <div className="text-ink">{t.description ?? t.noBillReason ?? "—"}</div>
              </div>
            </>
          ) : null}
          {t.note ? (
            <div className="col-span-2">
              <div className="text-sm text-muted">Notes</div>
              <div className="text-ink">{t.note}</div>
            </div>
          ) : null}
        </div>

        {d.files.length ? (
          <div className="flex flex-wrap gap-2">
            {d.files.map((f) => (
              <a key={f.id} href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-control border border-line px-3 py-2 text-sm text-ink hover:bg-canvas">
                <span className="rounded-[4px] bg-danger-soft px-1.5 text-2xs font-bold text-danger">{f.image ? "JPG" : "PDF"}</span>
                {f.name}
              </a>
            ))}
          </div>
        ) : null}

        {t.review === "sent_back" && t.reviewNote ? <Note tone="danger">Sent back: {t.reviewNote}</Note> : null}
        {approver && canWrite && t.review === "to_review" && t.status === "active" ? <ReviewButtons ids={[t.id]} size="md" /> : null}

        {cashReceipt && t.status === "active" ? (
          <div>
            <div className={cx(labelClass, "mb-3 font-semibold")}>How this cash was used</div>
            <Timeline
              items={[
                { tone: "success", title: `Received in cash · ${inr(t.amountPaise)}`, sub: `${fd(t.date)}${first ? ` ${first.at.slice(11, 16)}` : ""} · by ${t.by ?? "—"}` },
                ...d.uses.map((u) => ({
                  tone: (u.kind === "transfer" ? "brand" : "warn") as "brand" | "warn",
                  title: u.kind === "transfer" ? `${inr(u.amountPaise)} deposited to ${short(u.to)}` : `${inr(u.amountPaise)} ${u.petty || u.advanceId ? "petty cash" : "paid"} — ${u.category ?? u.description ?? ""}`,
                  sub: (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {u.label} · {u.kind === "transfer" ? `Cash → Bank${u.reference ? ` · ${/slip/i.test(u.reference) ? u.reference : `Slip ${u.reference}`}` : ""}` : `${u.by ?? ""}${u.review === "to_review" ? " · to review" : ""}`}
                      {u.kind === "transfer" ? (
                        <>
                          {" "}
                          · <BankMatch t={u} />
                        </>
                      ) : null}
                    </span>
                  ),
                })),
                { tone: "brand", title: `${inr(t.amountPaise - used)} still in ${t.to}`, sub: used ? "not linked to any use yet" : "nothing paid onward from it yet" },
              ]}
            />
          </div>
        ) : null}
        {cashReceipt ? <Note tone="info">Cash isn&apos;t kept separately per customer — the ledger tracks one cash balance. Links show what this receipt paid for, where somebody linked it.</Note> : null}

        <div className="border-t border-divider pt-4 text-sm leading-6 text-muted">
          History:{" "}
          {d.history.length
            ? d.history.map((h, i) => (
                <span key={i}>
                  {i ? " · " : ""}
                  {historyWord(h.action)} {fd(h.at.slice(0, 10))} {h.at.slice(11, 16)} {h.who ?? ""}
                </span>
              ))
            : `created ${fd(t.createdAt.slice(0, 10))} ${t.by ?? ""}`}
          {t.status === "cancelled" && t.cancelReason ? <div className="text-danger">Cancelled: {t.cancelReason}</div> : null}
        </div>
        {canWrite && t.status === "active" && !t.scrapReceiptId ? <CancelTxn id={t.id} /> : null}
      </div>
    </Drawer>
  );
}

/* --------------------------------------------------------------- advances */

export function advanceTone(a: AdvanceRow): { tone: "success" | "brand" | "warn" | "danger" | "muted"; label: string } {
  if (a.status === "settled") return { tone: "success", label: "Settled" };
  if (a.status === "cancelled") return { tone: "muted", label: "Cancelled" };
  if (a.position.toReview) return { tone: "brand", label: "Bills to review" };
  if (a.position.sentBack) return { tone: "danger", label: "Bills sent back" };
  if (!a.bills.length) return { tone: "warn", label: "Waiting for bills" };
  return { tone: "success", label: "Ready to settle" };
}

export function AdvancesTable({ rows, depts, today }: { rows: AdvanceRow[]; depts: Map<string, string | null>; today: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <Tr>
            {["Advance", "Given to", "Issued", "From", "Given", "Bills", "With them", "Status"].map((h, i) => (
              <Th key={h} align={i >= 4 && i <= 6 ? "right" : undefined} className="bg-surface">
                {h}
              </Th>
            ))}
          </Tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const s = advanceTone(a);
            const late = a.status === "open" && !a.bills.length && a.billsDueOn && a.billsDueOn < today;
            const owed = a.position.withThem < 0;
            return (
              <OpenRow key={a.id} id={a.id} param="adv" className="[&>td]:h-13 [&>td]:text-sm">
                <Td>
                  <span className="font-mono text-sm text-brand">{a.label}</span>
                </Td>
                <Td>
                  <div className="font-semibold text-ink">{a.employee}</div>
                  <div className="text-sm text-muted">{depts.get(a.employee.toLowerCase()) ?? a.purpose ?? ""}</div>
                </Td>
                <Td>{fd(a.issuedOn)}</Td>
                <Td>{a.issueTxn?.from ?? "—"}</Td>
                <Td align="right" className="font-semibold text-ink">
                  {inr(a.position.given)}
                </Td>
                <Td align="right">{a.bills.length ? `${a.bills.length} · ${inr(a.bills.filter((b) => b.status === "active").reduce((x, b) => x + b.amountPaise, 0))}` : "—"}</Td>
                <Td align="right">
                  <div className={cx("font-bold", owed ? "text-danger" : "text-ink")}>{inr(a.position.withThem)}</div>
                  {owed ? <div className="text-sm text-muted">owed to {a.employee.split(" ")[0]}</div> : null}
                </Td>
                <Td>{late ? <Pill tone="danger">Bills late</Pill> : <Pill tone={s.tone}>{s.label}</Pill>}</Td>
              </OpenRow>
            );
          })}
        </tbody>
      </table>
      {!rows.length ? <div className="px-5 py-10 text-center text-sm text-muted">No advances yet. Give one from + New › Advance.</div> : null}
    </div>
  );
}

export function AdvancePage({
  a,
  files,
  history,
  approver,
  canWrite,
  accounts,
  billsHref,
  backHref,
}: {
  a: AdvanceRow;
  files: Map<string, { id: string; name: string }[]>;
  history: { at: string; who: string | null; action: string }[];
  approver: boolean;
  canWrite: boolean;
  accounts: KitAccount[];
  billsHref: string;
  backHref: string;
}) {
  const s = advanceTone(a);
  const p = a.position;
  const allBills = a.bills.filter((b) => b.status === "active").reduce((x, b) => x + b.amountPaise, 0);
  const diff = p.given - allBills;
  const first = a.employee.split(" ")[0];
  const pending = a.bills.filter((b) => b.status === "active" && b.review === "to_review").length;
  const verb = diff < 0 ? `Settle · pay ${first} ${inr(-diff)}` : diff > 0 ? `Settle · ${first} returns ${inr(diff)}` : "Settle · nothing to move";
  const cashAccounts = accounts.filter((x) => x.kind !== "bank").map((x) => x.name);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-5">
      <div className="grid gap-5">
        <Panel className="px-6 py-5">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-2xl font-bold text-ink">
                  {a.label} · {a.employee}
                </span>
                <Pill tone={s.tone}>{s.label}</Pill>
              </div>
              <div className="mt-1.5 text-sm text-muted">
                For: {a.purpose ?? "—"}
                {a.billsDueOn ? ` · bills due ${fd(a.billsDueOn)}` : ""}
                {a.bills.length ? ` (submitted ${fd(a.bills[a.bills.length - 1].createdAt.slice(0, 10))})` : ""}
              </div>
            </div>
            <div className="text-right text-sm text-muted">
              Issued {fd(a.issuedOn)} · {a.issueTxn?.from ?? "—"} · {a.issueTxn?.label ?? ""}
              <div className="mt-2 flex justify-end gap-3">
                <Link href={backHref} className="text-sm font-semibold text-brand hover:underline">
                  ← All advances
                </Link>
                {a.status === "open" && canWrite ? (
                  <Link href={billsHref} className="text-sm font-semibold text-brand hover:underline">
                    Submit bills
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </Panel>
        <Panel className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <Tr>
                {["TXN ID", "Date", "Category", "Paid to", "Bill", "Amount", "Review"].map((h) => (
                  <Th key={h} align={h === "Amount" ? "right" : undefined} className="bg-surface">
                    {h}
                  </Th>
                ))}
              </Tr>
            </thead>
            <tbody>
              {a.bills.map((b) => {
                const f = files.get(b.id) ?? [];
                return (
                  <Tr key={b.id} className={cx("[&>td]:h-13 [&>td]:text-sm", b.review === "to_review" && b.status === "active" && approver && "bg-brand-soft/50")}>
                    <Td>
                      <span className="font-mono text-sm text-brand">{b.label}</span>
                    </Td>
                    <Td>{fd(b.date)}</Td>
                    <Td>{b.category}</Td>
                    <Td className="font-semibold text-ink">{b.payee ?? "—"}</Td>
                    <Td>
                      {f.length ? (
                        <a href={`/api/attachments/${f[0].id}`} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
                          photo
                        </a>
                      ) : (
                        <span title={b.noBillReason ?? undefined}>
                          <Pill tone="danger">No bill</Pill>
                        </span>
                      )}
                    </Td>
                    <Td align="right" className={cx(b.status === "cancelled" && "line-through")}>
                      {inr(b.amountPaise)}
                    </Td>
                    <Td>{approver && canWrite && b.status === "active" && b.review === "to_review" ? <ReviewButtons ids={[b.id]} /> : <ReviewPill t={b} />}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </table>
          {!a.bills.length ? <div className="px-5 py-8 text-center text-sm text-muted">No bills submitted yet{a.billsDueOn ? ` — due ${fd(a.billsDueOn)}` : ""}.</div> : null}
        </Panel>
        <Note tone="info">
          Each approved bill posts <b>once</b> as an expense paid from <b>Advance · {a.employee}</b>. {a.issueTxn?.from ?? "The account"} does not move again — it moved when the advance was given.
        </Note>
      </div>

      <Panel className="px-6 py-5">
        <div className="mb-3 text-md font-semibold text-ink">Settle the advance</div>
        <div className="grid text-sm">
          <div className="flex justify-between border-b border-dashed border-line py-2.5">
            <span className="text-body">Given</span>
            <b className="text-ink">{inr(p.given)}</b>
          </div>
          <div className="flex justify-between border-b border-dashed border-line py-2.5">
            <span className="text-body">Bills, if all approved</span>
            <b className="text-ink">{inr(allBills)}</b>
          </div>
          <div className="flex justify-between py-2.5">
            <span className="text-body">Difference</span>
            <b className={diff < 0 ? "text-danger" : diff > 0 ? "text-success" : "text-ink"}>{diff < 0 ? `${inr(-diff)} owed to ${first}` : diff > 0 ? `${inr(diff)} to come back` : "₹0"}</b>
          </div>
        </div>
        {a.status === "open" ? (
          <div className="mt-4">
            <div className="mb-1.5 text-sm font-semibold text-body">{diff < 0 ? "Pay it back from" : "Return it into"}</div>
            <SettleBox
              advanceId={a.id}
              accounts={cashAccounts.length ? cashAccounts : accounts.map((x) => x.name)}
              defaultAccount={a.issueTxn?.from && cashAccounts.includes(a.issueTxn.from) ? a.issueTxn.from : (cashAccounts[0] ?? "")}
              verb={verb}
              disabled={!approver || !canWrite || !!p.settleWhy}
              why={p.settleWhy ? (pending ? `Waiting on ${pending} bill${pending === 1 ? "" : "s"} to review` : p.settleWhy) : !approver ? "Only the accountant settles an advance" : null}
            />
          </div>
        ) : (
          <div className="mt-3 text-sm text-muted">This advance is {a.status}.</div>
        )}
        <div className="mt-6 border-t border-divider pt-5">
          <div className={cx(labelClass, "mb-4 font-semibold")}>History</div>
          <Timeline
            items={[
              { tone: "success", title: `${inr(p.given)} given${a.issueTxn?.mode === "Cash" ? " in cash" : a.issueTxn?.mode ? ` by ${a.issueTxn.mode}` : ""}`, sub: `${fd(a.issuedOn)} · by ${a.by ?? "—"}` },
              ...a.bills
                .filter((b) => b.review === "approved")
                .map((b) => ({ tone: "brand" as const, title: `${b.payee ?? b.category} ${inr(b.amountPaise)} approved`, sub: `${b.reviewedAt ? fd(b.reviewedAt.slice(0, 10)) : ""} · by ${b.reviewedBy ?? "—"}` })),
              ...(pending
                ? [{ tone: "warn" as const, title: `${pending} bill${pending === 1 ? "" : "s"} submitted${a.billsDueOn && a.bills[a.bills.length - 1].date > a.billsDueOn ? ", late" : ""}`, sub: `${fd(a.bills[a.bills.length - 1].createdAt.slice(0, 10))}` }]
                : []),
              ...a.settlements.map((x) => ({ tone: "success" as const, title: x.kind === "advance_return" ? `${inr(x.amountPaise)} returned` : `${inr(x.amountPaise)} paid back`, sub: `${fd(x.date)} · ${x.to ?? x.from ?? ""}` })),
            ]}
          />
          {history.length ? <div className="mt-4 text-sm text-muted">{history.length} recorded step{history.length === 1 ? "" : "s"} in the audit trail.</div> : null}
        </div>
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------------- statement */

export function StatementView({ st, openId }: { st: NonNullable<Awaited<ReturnType<typeof statementView>>>; openId: string | null }) {
  const cash = st.account.kind !== "bank";
  const rows = [...st.rows].reverse();
  return (
    <div className="grid gap-5">
      <SumStrip
        items={[
          { l: `Opening · ${st.from ? fd(st.from) : "start"}`, v: inr(st.opening) },
          "+",
          { l: cash ? "Cash in" : "Money in", v: inr(st.inPaise), tone: "success" },
          "−",
          { l: cash ? "Cash out" : "Money out", v: inr(st.outPaise), tone: "danger" },
          "=",
          { l: "Closing", v: inr(st.closing) },
        ]}
      />
      <Panel>
        <table className="w-full">
          <thead>
            <Tr>
              {["Date", "TXN ID", "Type", "Party", cash ? "Cash in" : "Money in", cash ? "Cash out" : "Money out", "Balance"].map((h, i) => (
                <Th key={h} align={i >= 4 ? "right" : undefined} className="bg-surface">
                  {h}
                </Th>
              ))}
            </Tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = r.t;
              const type = t.kind === "transfer" ? `${t.fromKind === "bank" ? "Bank" : "Cash"} → ${t.toKind === "bank" ? "Bank" : "Cash"}` : MONEY_KIND_LABEL[t.kind];
              const party = t.kind === "transfer" ? short(t.fromAccountId === st.account.id ? t.to : t.from) : (t.customer ?? t.payer ?? t.payee ?? t.advanceEmployee ?? "—");
              const strong = t.kind === "receipt";
              return (
                <OpenRow key={t.id} id={t.id} selected={t.id === openId} className="[&>td]:h-11 [&>td]:text-sm">
                  <Td>{fd(t.date)}</Td>
                  <Td>
                    <TxnId t={t} />
                  </Td>
                  <Td>{type}</Td>
                  <Td className={strong ? "font-semibold text-ink" : undefined}>{party}</Td>
                  <Td align="right" className="font-semibold text-success">
                    {r.inPaise ? inr(r.inPaise) : ""}
                  </Td>
                  <Td align="right" className="font-semibold text-danger">
                    {r.outPaise ? inr(r.outPaise) : ""}
                  </Td>
                  <Td align="right" className="font-bold text-ink">
                    {inr(r.balance)}
                  </Td>
                </OpenRow>
              );
            })}
          </tbody>
        </table>
        {!rows.length ? <div className="px-5 py-10 text-center text-sm text-muted">Nothing moved in {st.account.name} this period.</div> : null}
      </Panel>
    </div>
  );
}

/* -------------------------------------------------------------------- bank */

type BankData = NonNullable<Awaited<ReturnType<typeof bankView>>>;

const rupee2 = (p: number) => {
  const v = (p / 100).toFixed(2);
  const [w, d] = v.split(".");
  return `${nf(Number(w))}.${d}`;
};

export function BankView({ b, tab, hrefFor, approver, accounts }: { b: BankData; tab: string; hrefFor: (q: Record<string, string | null>) => string; approver: boolean; accounts: KitAccount[] }) {
  const sel = b.selected;
  const amount = sel ? sel.debitPaise + sel.creditPaise : 0;
  const lineState = (s: string) =>
    s === "matched" ? <Pill tone="success">Matched</Pill> : s === "ignored" ? <Pill tone="muted">Ignored</Pill> : s === "review" ? <Pill tone="warn">Needs review</Pill> : s === "partial" ? <Pill tone="warn">Part matched</Pill> : <Pill tone="danger">Unmatched</Pill>;
  const tabs: { k: string; l: string; n: number }[] = [
    { k: "all", l: "All", n: b.counts.all },
    { k: "unmatched", l: "Unmatched", n: b.counts.unmatched },
    { k: "matched", l: "Matched", n: b.counts.matched },
    { k: "ignored", l: "Ignored", n: b.counts.ignored },
    { k: "review", l: "Needs review", n: b.counts.review },
  ];
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {b.accounts.map((a) => (
          <Link
            key={a.id}
            href={hrefFor({ acct: a.id, line: null })}
            className={cx("flex items-center gap-3 rounded-card border bg-surface px-4 py-2.5", a.id === b.account.id ? "border-2 border-brand" : "border-line hover:border-muted")}
          >
            <AccountMark kind="bank" name={a.name} index={accounts.filter((x) => x.kind === "bank").findIndex((x) => x.id === a.id)} />
            <span>
              <span className="block text-sm font-semibold text-ink">
                {a.name}
                {a.last4 ? ` ••${a.last4}` : ""}
              </span>
              <span className="block text-sm text-muted">{a.unmatched ? `${a.unmatched} unmatched` : `all matched${a.lastMatched ? ` to ${fd(a.lastMatched)}` : ""}`}</span>
            </span>
          </Link>
        ))}
        <span className="flex-1" />
        {approver ? <ImportStatement accounts={b.accounts.map((a) => a.name)} current={b.account.name} /> : null}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_420px] items-start gap-5">
        <Panel>
          <SubTabs tabs={tabs.map((t) => ({ key: t.k, label: t.l, count: t.n, href: hrefFor({ bt: t.k, line: null }), active: t.k === tab }))} />
          <table className="w-full">
            <thead>
              <Tr>
                {["Txn date", "Description", "Debit", "Credit", "Bank ref", "Status"].map((h, i) => (
                  <Th key={h} align={i === 2 || i === 3 ? "right" : undefined} className="bg-surface">
                    {h}
                  </Th>
                ))}
              </Tr>
            </thead>
            <tbody>
              {b.lines.map(({ l, state }) => (
                <OpenRow key={l.id} id={l.id} param="line" selected={l.id === sel?.id} className="[&>td]:h-11 [&>td]:text-sm">
                  <Td>{fd(l.date)}</Td>
                  <Td className="max-w-72 truncate font-semibold text-ink" title={l.description}>
                    {l.description}
                  </Td>
                  <Td align="right" className="font-semibold text-danger">
                    {l.debitPaise ? rupee2(l.debitPaise) : ""}
                  </Td>
                  <Td align="right" className="font-semibold text-success">
                    {l.creditPaise ? rupee2(l.creditPaise) : ""}
                  </Td>
                  <Td className="max-w-36 truncate text-muted" title={l.reference ?? undefined}>
                    {l.reference ?? "—"}
                  </Td>
                  <Td>{lineState(state)}</Td>
                </OpenRow>
              ))}
            </tbody>
          </table>
          {!b.lines.length ? <div className="px-5 py-10 text-center text-sm text-muted">No lines here. Import the bank&apos;s statement to start matching.</div> : null}
        </Panel>

        <div className="grid gap-5">
          <Panel className="border-brand-softer px-5 py-4">
            {sel ? (
              <>
                <div className="text-md font-semibold text-ink">Match this line</div>
                <div className="mt-0.5 text-sm text-muted">
                  {fd(sel.date)} · {short(b.account.name)} {sel.debitPaise ? "debit" : "credit"} {inr(amount)} · {sel.description}
                </div>
                <div className="mt-4 grid gap-3">
                  {sel.matches.length
                    ? sel.matches.map((m) => (
                        <div key={m.id} className="rounded-card border border-success px-4 py-3 text-sm">
                          <Pill tone="success">Matched</Pill> <span className="font-mono text-brand">{m.label}</span> · {m.party} · {inr(m.amountPaise)}
                        </div>
                      ))
                    : null}
                  {b.candidates.map((c, i) => (
                    <div key={c.t.id} className={cx("flex items-center gap-3 rounded-card border px-4 py-3", c.score === "exact" ? "border-2 border-success" : "border-line")}>
                      <span className={cx("rounded-control px-2 py-1 text-sm font-semibold", c.score === "exact" ? "bg-success-soft text-success" : "bg-warn-soft text-warn-ink")}>{c.score === "exact" ? "Exact" : c.score === "amount" ? "Amount" : "Near"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-ink">
                          {MONEY_KIND_LABEL[c.t.kind]} · {c.t.payee ?? c.t.customer ?? c.t.payer ?? `${short(c.t.from)} → ${short(c.t.to)}`}
                        </div>
                        <div className="text-sm text-muted">
                          <span className="font-mono text-brand">{c.t.label}</span> · {fd(c.t.date)}
                          {c.t.from ? ` · ${short(c.t.from)}` : ""}
                          {c.score === "exact" ? " · reference matches" : c.days ? ` · ${c.days} day${c.days === 1 ? "" : "s"} apart` : ""}
                          {c.t.duplicateOverride ? " · possible duplicate" : ""}
                        </div>
                      </div>
                      {approver ? <MatchButton lineId={sel.id} txnId={c.t.id} primary={i === 0 && c.score === "exact"} /> : null}
                    </div>
                  ))}
                  {!b.candidates.length && !sel.matches.length ? <div className="text-sm text-muted">Nothing in Petty Cash looks like this line.</div> : null}
                </div>
                {approver ? (
                  <div className="mt-4 text-sm leading-6 text-muted">
                    Covers several bills? <SplitLink lineId={sel.id} amount={amount} options={b.candidates.map((c) => ({ id: c.t.id, label: `${c.t.label} · ${c.t.payee ?? c.t.customer ?? c.t.payer ?? ""}`, left: c.left }))} /> — must add up to {inr(amount)}.
                  </div>
                ) : null}
                <div className="mt-4 border-t border-divider pt-4 text-sm leading-6 text-muted">
                  Nothing represents it?{" "}
                  <Link href={erpLink("bankLines", { open: sel.id })} className="font-semibold text-brand hover:underline">
                    Create transaction from this line
                  </Link>
                  <div>Only offered when no match exists · the accountant only</div>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted">Pick a line to match it.</div>
            )}
          </Panel>
          {b.others.length ? (
            <Panel className="px-5 py-4">
              <div className="mb-3 text-md font-semibold text-ink">Suggested for the other lines</div>
              <div className="grid divide-y divide-divider">
                {b.others.map(({ l, c }) => (
                  <div key={l.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {l.description} → <b className="text-ink">{MONEY_KIND_LABEL[c!.t.kind]}</b> <span className="font-mono text-brand">{c!.t.label.slice(-5)}</span>
                      {c!.score !== "exact" && c!.t.amountPaise !== l.debitPaise + l.creditPaise ? <span className="text-muted"> {inr(c!.t.amountPaise)} ≠ {inr(l.debitPaise + l.creditPaise)}</span> : null}
                    </span>
                    {approver ? c!.score === "near" ? <Link href={hrefFor({ line: l.id })} className="font-semibold text-brand hover:underline">Review</Link> : <MatchLink lineId={l.id} txnId={c!.t.id} /> : null}
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- overview */

export function AccountCards({ accounts, day }: { accounts: (KitAccount & { unmatched: number })[]; day: string }) {
  return (
    <CardGrid min="card" className="mb-5">
      {accounts.map((a) => (
        <Card key={a.id} className="px-5 py-4">
          <div className="flex items-center gap-2">
            <AccountMark kind={a.kind} name={a.name} size="sm" index={accounts.filter((x) => x.kind === "bank").findIndex((x) => x.id === a.id)} />
            <span className="text-sm font-semibold text-ink">
              {a.name}
              {a.last4 ? ` ••${a.last4}` : ""}
            </span>
          </div>
          <div className={cx("mt-1.5 text-2xl font-bold tabular-nums", a.balance < 0 ? "text-danger" : "text-ink")}>{inr(a.balance)}</div>
          <div className="mt-1 text-sm text-muted">
            {a.kind === "bank" ? (a.unmatched ? `${nf(a.unmatched)} bank line${a.unmatched === 1 ? "" : "s"} not matched` : `Reconciled to ${fd(day)}`) : a.balance < 0 ? "Below zero — a transfer in is missing" : a.kind === "petty" ? "with the Production Head" : "in the office"}
          </div>
        </Card>
      ))}
    </CardGrid>
  );
}

export { erpLink };
