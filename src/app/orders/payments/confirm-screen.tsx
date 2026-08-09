"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  MetricStrip,
  PageHeader,
  SectionLabel,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { confirmReceiptAction, rejectReceiptAction } from "@/lib/actions/payments";
import { money, stamp } from "@/lib/format";

type PendingReceipt = {
  receiptId: string;
  customerId: string;
  customerName: string;
  amount: number;
  receivedAt: string;
  mode: string;
  reference: string | null;
  note: string | null;
  source: string;
  reportedBy: string | null;
  reportedAt: string;
  waitingHours: number;
  lines: Array<{ billId: string | null; billNo: string | null; amount: number }>;
  outstanding: number;
};

/** Where the claim came from, in words rather than a stored identifier. */
const SOURCE_LABEL: Record<string, string> = {
  collections_call: "Reported on a collections call",
  bills_screen: "Entered against a bill",
  accounts: "Entered by accounts",
  sheet_import: "From the payment sheet",
};

function waitingLabel(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h waiting`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} waiting`;
}

export function ConfirmScreen({
  canConfirm,
  staleAfterHours,
  quietDays,
  receipts,
}: {
  canConfirm: boolean;
  staleAfterHours: number;
  quietDays: number;
  receipts: PendingReceipt[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [openId, setOpenId] = React.useState<string | null>(null);

  const open = receipts.find((r) => r.receiptId === openId) ?? null;
  const total = receipts.reduce((sum, r) => sum + r.amount, 0);
  const stale = receipts.filter((r) => r.waitingHours >= staleAfterHours);

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Payments to confirm"
        subtitle="Money somebody has been told about and nobody has found yet. Nothing here has moved a bill, and the customer is not being chased for it in the meantime."
      />

      <MetricStrip
        metrics={[
          { label: "Waiting", value: String(receipts.length) },
          { label: "Value claimed", value: money(total) },
          {
            label: `Over ${staleAfterHours}h old`,
            value: String(stale.length),
            tone: stale.length ? "danger" : undefined,
            sub: stale.length ? "customer is going unchased on this" : undefined,
          },
        ]}
      />

      {!canConfirm ? (
        <Card className="mt-4 border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <span className="text-sm text-warn-ink">
            You can see what is waiting but not decide on it — confirming that
            money arrived is the accounts team&apos;s, because they hold the bank
            statement.
          </span>
        </Card>
      ) : null}

      {stale.length ? (
        <Card className="mt-4 border-danger-line border-l-[3px] border-l-danger bg-danger-soft px-4 py-3">
          <span className="text-sm text-danger-ink">
            {stale.length === 1 ? "One payment has" : `${stale.length} payments have`}{" "}
            been waiting more than {staleAfterHours} hours. A customer is left
            alone for {quietDays} {quietDays === 1 ? "day" : "days"} on the
            strength of a reported payment — after that they are chased again,
            whether or not this was ever decided.
          </span>
        </Card>
      ) : null}

      <Card className="mt-4 overflow-hidden">
        {receipts.length ? (
          <table>
            <thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Received</Th>
                <Th>How</Th>
                <Th>Reported by</Th>
                <Th align="right">Settles</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Waiting</Th>
                <Th />
              </Tr>
            </thead>
            <tbody>
              {receipts.map((r) => {
                const bills = r.lines.filter((l) => l.billId);
                const onAccount = r.lines
                  .filter((l) => !l.billId)
                  .reduce((s, l) => s + l.amount, 0);
                return (
                  <Tr key={r.receiptId}>
                    <Td>
                      <span className="font-medium text-ink">{r.customerName}</span>
                      <span className="mt-0.5 block text-[12px] text-muted">
                        {money(r.outstanding)} owed
                      </span>
                    </Td>
                    <Td>{r.receivedAt}</Td>
                    <Td>
                      {r.mode}
                      {r.reference ? (
                        <span className="mt-0.5 block text-[12px] text-muted">
                          {r.reference}
                        </span>
                      ) : (
                        <span className="mt-0.5 block text-[12px] text-muted">
                          no reference
                        </span>
                      )}
                    </Td>
                    <Td>
                      {r.reportedBy ?? "—"}
                      <span className="mt-0.5 block text-[12px] text-muted">
                        {SOURCE_LABEL[r.source] ?? r.source}
                      </span>
                    </Td>
                    <Td align="right">
                      {bills.length ? (
                        <span>
                          {bills.length} bill{bills.length === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-muted">on account</span>
                      )}
                      {onAccount > 0 && bills.length ? (
                        <span className="mt-0.5 block text-[12px] text-muted">
                          + {money(onAccount)} on account
                        </span>
                      ) : null}
                    </Td>
                    <Td align="right" className="font-medium tabular-nums">
                      {money(r.amount)}
                    </Td>
                    <Td align="right">
                      <Badge
                        tone={r.waitingHours >= staleAfterHours ? "danger" : "muted"}
                      >
                        {waitingLabel(r.waitingHours)}
                      </Badge>
                    </Td>
                    <Td align="right">
                      <Button size="sm" onClick={() => setOpenId(r.receiptId)}>
                        Review
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="Nothing waiting"
            body="Every payment reported has been decided on. Money entered by accounts is confirmed as it is written and never appears here."
          />
        )}
      </Card>

      {open ? (
        <ReviewDrawer
          // A different receipt remounts with fresh state rather than being
          // reset by an effect.
          key={open.receiptId}
          receipt={open}
          canConfirm={canConfirm}
          run={run}
          onClose={() => setOpenId(null)}
          onDecided={() => {
            setOpenId(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewDrawer({
  receipt,
  canConfirm,
  run,
  onClose,
  onDecided,
}: {
  receipt: PendingReceipt;
  canConfirm: boolean;
  run: ReturnType<typeof useToast>["run"];
  onClose: () => void;
  onDecided: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const bills = receipt.lines.filter((l) => l.billId);
  const onAccount = receipt.lines
    .filter((l) => !l.billId)
    .reduce((s, l) => s + l.amount, 0);

  return (
    <Drawer open onClose={onClose} width={560} label="Review payment">
      <DrawerHeader onClose={onClose}>
        <span className="font-medium text-ink">{receipt.customerName}</span>
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="text-[28px] font-medium tabular-nums text-ink">
          {money(receipt.amount)}
        </div>
        <div className="mt-1 text-[13px] text-muted">
          {receipt.mode}
          {receipt.reference ? ` · ${receipt.reference}` : " · no reference given"}
          {` · received ${receipt.receivedAt}`}
        </div>

        <div className="mt-5">
          <SectionLabel>Where it came from</SectionLabel>
          <div className="mt-2 text-[13px] text-ink">
            {SOURCE_LABEL[receipt.source] ?? receipt.source}
            {receipt.reportedBy ? ` by ${receipt.reportedBy}` : ""}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            {stamp(new Date(receipt.reportedAt))} · {waitingLabel(receipt.waitingHours)}
          </div>
          {receipt.note ? (
            <div className="mt-2 rounded-md bg-canvas px-3 py-2 text-[13px] text-ink">
              {receipt.note}
            </div>
          ) : null}
        </div>

        <div className="mt-5">
          <SectionLabel>What confirming it would settle</SectionLabel>
          {bills.length ? (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line">
              {bills.map((l) => (
                <li
                  key={l.billId}
                  className="flex items-center justify-between px-3 py-2 text-[13px]"
                >
                  <span className="text-ink">{l.billNo}</span>
                  <span className="tabular-nums text-ink">{money(l.amount)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {onAccount > 0 ? (
            <div className="mt-2 rounded-md border border-line px-3 py-2 text-[13px] text-muted">
              {money(onAccount)} would sit on account — received, not yet against
              a bill, and offered against the next one.
            </div>
          ) : null}
          <div className="mt-2 text-[12px] text-muted">
            {receipt.customerName} owes {money(receipt.outstanding)} in total.
          </div>
        </div>

        <div className="mt-6">
          <SectionLabel>If the money never arrived</SectionLabel>
          <Field
            label="Reason"
            hint="This lands on the customer's timeline. Whoever was told about the payment has to ring back and say something."
            className="mt-2"
          >
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Not in the bank statement for that date…"
            />
          </Field>
          <Button
            variant="danger"
            className="mt-2"
            disabled={busy || !canConfirm || !reason.trim()}
            title={
              !canConfirm
                ? "Only the accounts team can decide on a payment"
                : reason.trim()
                  ? undefined
                  : "A reason is required"
            }
            onClick={async () => {
              setBusy(true);
              const r = await run(rejectReceiptAction(receipt.receiptId, reason));
              setBusy(false);
              if (r.ok) onDecided();
            }}
          >
            Reject this payment
          </Button>
        </div>
      </div>

      <div className={cx("flex flex-none gap-2 border-t border-line px-5 py-3")}>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Close
        </Button>
        <span className="flex-1" />
        <Button
          variant="primary"
          disabled={!canConfirm || busy}
          title={
            canConfirm
              ? undefined
              : "Only the accounts team can confirm that money arrived"
          }
          onClick={async () => {
            setBusy(true);
            const r = await run(confirmReceiptAction(receipt.receiptId));
            setBusy(false);
            if (r.ok) onDecided();
          }}
        >
          Confirm {money(receipt.amount)} received
        </Button>
      </div>
    </Drawer>
  );
}
