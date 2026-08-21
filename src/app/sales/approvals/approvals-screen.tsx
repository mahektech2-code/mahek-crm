"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { money, parseRupees } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { decideApproval, type ApprovalDecision } from "@/lib/actions/sales";
import type { DecidedApproval, PendingApproval } from "@/lib/services/sales-service";
import { SalesIcon } from "../icons";
import {
  APPROVAL_LABEL,
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
  label,
  plural,
  waitingWords,
} from "../parts";

/**
 * Everything waiting on an answer.
 *
 * Oldest first, and not grouped by kind: this is a list of people waiting, and
 * a salesman standing in a shop on a credit override has been waiting longer
 * than whoever asked for leave this morning. Sorting by type would bury him
 * under whatever the manager finds most interesting.
 *
 * Refusing takes a reason and the form will not submit without one. It is not
 * politeness: the salesman has to be able to do something differently, and he
 * cannot work that out from the word "declined" — he is usually still in front
 * of the customer.
 */
export function ApprovalsScreen({
  pending,
  decided,
  oldestHours,
  staleHours,
  nowMs,
}: {
  pending: PendingApproval[];
  decided: DecidedApproval[];
  oldestHours: number;
  /** Past this, waiting is worth flagging rather than merely counting. */
  staleHours: number;
  /**
   * The clock, read once on the server and passed down. A client component may
   * not read it during render — the React Compiler rules are on and a value
   * that changes between renders makes an elapsed timer jump about.
   */
  nowMs: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState<PendingApproval | null>(null);
  const [decision, setDecision] = React.useState<ApprovalDecision>("approved");
  const [note, setNote] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(row: PendingApproval, initial: ApprovalDecision) {
    setOpen(row);
    setDecision(initial);
    setNote("");
    setAmount(row.amountPaise ? String(Math.round(row.amountPaise / 100)) : "");
    setError(null);
  }

  async function submit() {
    if (!open) return;
    setBusy(true);
    setError(null);

    const paise = decision === "partially_approved" ? parseRupees(amount) : undefined;
    let result;
    try {
      result = await decideApproval({
        approvalId: open.id,
        decision,
        note: note.trim() || undefined,
        approvedAmountPaise: paise ?? undefined,
      });
    } finally {
      // Cleared whatever happened: an action that rejects rather than
      // returning a Result would otherwise leave this button disabled
      // until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(null);
    toast.push(result.message ?? "Answered.");
    router.refresh();
  }

  const byType = new Map<string, number>();
  for (const p of pending) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Approvals"
        subtitle="Everything the field team is waiting on, oldest first. A refusal needs a reason — whoever asked is usually still standing in the shop."
      />

      {pending.length && oldestHours >= staleHours ? (
        <Banner
          tone="danger"
          title={`The oldest request has been waiting ${waitingWords(oldestHours)}`}
          body="A salesman asked for something and has heard nothing since. Until it is answered his handset shows it as pending and he has no way to move."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Waiting", value: String(pending.length) },
          {
            label: "Oldest",
            value: pending.length ? waitingWords(oldestHours) : "—",
            tone: pending.length && oldestHours >= staleHours ? "danger" : undefined,
          },
          ...[...byType.entries()].map(([type, n]) => ({
            label: label(APPROVAL_LABEL, type),
            value: String(n),
          })),
        ]}
      />

      {pending.length === 0 ? (
        <Empty
          title="Nothing is waiting"
          body="Expenses, leave, samples and attendance corrections raised on a handset land here. An order over the credit limit is accounts' decision and waits in Accounts → Order approvals instead."
        />
      ) : (
        <Table
          minWidth={1080}
          head={
            <>
              <HeadCell width={170}>Asked for</HeadCell>
              <HeadCell width={170}>By</HeadCell>
              <HeadCell>What</HeadCell>
              <HeadCell align="right" width={130}>Amount</HeadCell>
              <HeadCell width={130}>Waiting</HeadCell>
              <HeadCell align="right" width={220} />
            </>
          }
        >
          {pending.map((p, i) => {
            const hours = Math.floor((nowMs - new Date(p.requestedAt).getTime()) / 3_600_000);
            const isOrder = p.type === "order";
            return (
              <Row key={p.id} striped={i % 2 === 1}>
                <Cell>
                  <Pill tone={isOrder ? "neutral" : "brand"}>{label(APPROVAL_LABEL, p.type)}</Pill>
                </Cell>
                <Cell truncate={170}>
                  <Link
                    href={`/sales/people/${p.requestedById}`}
                    className="font-medium text-ink no-underline hover:underline"
                  >
                    {p.requestedByName}
                  </Link>
                </Cell>
                <Cell truncate={360} title={p.reason ?? undefined}>
                  <span className="text-ink">{p.summary}</span>
                  {p.customerName ? (
                    <span className="text-muted"> · {p.customerName}</span>
                  ) : null}
                  {p.reason ? (
                    <span className="block truncate text-[12px] text-muted">“{p.reason}”</span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {p.amountPaise ? money(p.amountPaise) : <span className="text-muted">—</span>}
                </Cell>
                <Cell>
                  <span className={hours >= staleHours ? "text-danger" : "text-muted"}>
                    {waitingWords(hours)}
                  </span>
                </Cell>
                <Cell align="right">
                  {isOrder ? (
                    <Link
                      href="/accounts/approvals"
                      title="An order over the credit limit is accounts' decision, not the sales desk's — the person chasing the target does not sign off the orders that hit it."
                      className="text-[13px] text-[#5223E0] no-underline hover:underline"
                    >
                      Accounts decide this →
                    </Link>
                  ) : (
                    <span className="flex justify-end gap-1.5">
                      <Button size="sm" tone="primary" onClick={() => begin(p, "approved")}>
                        <SalesIcon name="tick" size={14} />
                        Approve
                      </Button>
                      {p.amountPaise ? (
                        <Button size="sm" onClick={() => begin(p, "partially_approved")}>
                          Part
                        </Button>
                      ) : null}
                      <Button size="sm" tone="danger" onClick={() => begin(p, "rejected")}>
                        Refuse
                      </Button>
                    </span>
                  )}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}

      {decided.length ? (
        <div className="mt-8">
          <h2 className="mb-2 text-[15px] font-semibold text-ink">Lately decided</h2>
          <Table
            minWidth={900}
            head={
              <>
                <HeadCell width={170}>Kind</HeadCell>
                <HeadCell width={170}>Asked by</HeadCell>
                <HeadCell width={140}>Answer</HeadCell>
                <HeadCell width={170}>By</HeadCell>
                <HeadCell>Said</HeadCell>
              </>
            }
          >
            {decided.map((d, i) => (
              <Row key={d.id} striped={i % 2 === 1}>
                <Cell>{label(APPROVAL_LABEL, d.type)}</Cell>
                <Cell truncate={170}>{d.requestedByName}</Cell>
                <Cell>
                  <Pill
                    tone={
                      d.state === "approved"
                        ? "success"
                        : d.state === "rejected"
                          ? "danger"
                          : "warn"
                    }
                  >
                    {d.state === "partially_approved"
                      ? `Part${d.approvedAmountPaise ? ` · ${money(d.approvedAmountPaise)}` : ""}`
                      : d.state}
                  </Pill>
                </Cell>
                <Cell truncate={170}>{d.approverName ?? "—"}</Cell>
                <Cell truncate={400}>{d.decisionNote ?? "—"}</Cell>
              </Row>
            ))}
          </Table>
        </div>
      ) : null}

      <Modal
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={
          decision === "approved"
            ? "Approve this"
            : decision === "partially_approved"
              ? "Approve part of it"
              : "Refuse this"
        }
        width={520}
      >
        {open ? (
          <>
            <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              <div className="font-medium text-ink">{open.summary}</div>
              <div className="text-muted">
                {open.requestedByName} · {label(APPROVAL_LABEL, open.type)}
                {open.amountPaise ? ` · ${money(open.amountPaise)} asked for` : ""}
              </div>
              {open.reason ? (
                <div className="mt-1 text-body">“{open.reason}”</div>
              ) : null}
            </div>

            {decision === "partially_approved" ? (
              <label className="mb-3 block">
                <span className="mb-1 block text-[13px] font-medium text-ink">
                  Amount you are allowing
                </span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="numeric"
                  placeholder="1200"
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                />
                <span className="mt-1 block text-[12px] text-muted">
                  In rupees. Approving less than was asked for is a different answer from yes, and
                  recording it as yes loses the difference on payday.
                </span>
              </label>
            ) : null}

            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                {decision === "approved" ? "Anything to add (optional)" : "Why"}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder={
                  decision === "approved"
                    ? "Goes to their handset with the answer"
                    : "They have to be able to do something differently"
                }
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>

            {error ? (
              <p className="mt-2 text-[13px] text-danger">{error}</p>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button
                tone={decision === "rejected" ? "danger" : "primary"}
                disabled={busy || (decision !== "approved" && !note.trim())}
                title={
                  decision !== "approved" && !note.trim()
                    ? "Say why — they cannot work it out from the word alone."
                    : undefined
                }
                onClick={() => void submit()}
              >
                {busy
                  ? "Saving…"
                  : decision === "approved"
                    ? "Approve"
                    : decision === "partially_approved"
                      ? "Approve part"
                      : "Refuse"}
              </Button>
            </div>

            <p className="mt-3 text-[12px] text-muted">
              {plural(1, "answer")} reaches {open.requestedByName}&rsquo;s handset on its next sync,
              as a notification and on the record itself.
            </p>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
