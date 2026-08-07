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
  SlowPayerBadge,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { approveOrderAction, declineOrderAction } from "@/lib/actions/orders";
import { money, phoneDisplay, stamp } from "@/lib/format";

type PendingOrder = {
  orderId: string;
  customerId: string;
  customerName: string;
  customerCity: string;
  contactPerson: string;
  phone: string;
  outstanding: number;
  overdueBills: number;
  slowPayer: boolean;
  creditDays: number | null;
  orderedAt: string;
  takenByName: string | null;
  totalAmount: number;
  lineCount: number;
  waitingHours: number;
};

type Line = { productName: string; packSize: string | null; quantity: number };

/** Waiting a day is worth saying out loud; waiting an hour is not. */
function waitingLabel(hours: number): { text: string; urgent: boolean } {
  if (hours < 1) return { text: "just now", urgent: false };
  if (hours < 24) return { text: `${hours}h waiting`, urgent: false };
  const days = Math.floor(hours / 24);
  return {
    text: `${days} day${days === 1 ? "" : "s"} waiting`,
    urgent: days >= 2,
  };
}

export function ApprovalScreen({
  canApprove,
  orders,
}: {
  canApprove: boolean;
  orders: PendingOrder[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [openId, setOpenId] = React.useState<string | null>(null);

  const open = orders.find((o) => o.orderId === openId) ?? null;
  const totalValue = orders.reduce((sum, o) => sum + o.totalAmount, 0);
  const withDebt = orders.filter((o) => o.outstanding > 0).length;
  const waitingOver = orders.filter((o) => o.waitingHours >= 24).length;

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Order approvals"
        subtitle="Every order taken on a call waits here. Nothing is billed, and nothing counts towards a target, until it is approved."
      />

      <MetricStrip
        metrics={[
          { label: "Waiting", value: String(orders.length) },
          { label: "Value held", value: money(totalValue) },
          { label: "With money owed", value: String(withDebt) },
          {
            label: "Over a day old",
            value: String(waitingOver),
            tone: waitingOver ? "danger" : undefined,
          },
        ]}
      />

      {!canApprove ? (
        <Card className="mt-4 border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <span className="text-sm text-warn-ink">
            You can see this queue but not decide on it — approving an order is
            the accounts team&apos;s. Nothing here is actionable for you.
          </span>
        </Card>
      ) : null}

      <Card className="mt-4 overflow-hidden">
        {orders.length ? (
          <table>
            <thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Taken</Th>
                <Th align="right">Owed now</Th>
                <Th align="right">Items</Th>
                <Th align="right">Order value</Th>
                <Th align="right">Waiting</Th>
                <Th />
              </Tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const waiting = waitingLabel(o.waitingHours);
                return (
                  <Tr key={o.orderId}>
                    <Td>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">
                          {o.customerName}
                        </span>
                        {o.slowPayer ? <SlowPayerBadge /> : null}
                        {o.overdueBills ? (
                          <Badge tone="danger">
                            {o.overdueBills} bill
                            {o.overdueBills === 1 ? "" : "s"} overdue
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-[13px] text-muted">
                        {o.contactPerson} · {phoneDisplay(o.phone)} ·{" "}
                        {o.customerCity}
                      </span>
                    </Td>
                    <Td>
                      <span className="block text-sm text-body">
                        {o.takenByName ?? "—"}
                      </span>
                      <span className="block text-[13px] text-muted">
                        {stamp(o.orderedAt)}
                      </span>
                    </Td>
                    <Td
                      align="right"
                      className={o.outstanding > 0 ? "text-danger" : undefined}
                    >
                      {money(o.outstanding)}
                    </Td>
                    <Td align="right">{o.lineCount}</Td>
                    <Td align="right" className="font-medium text-ink">
                      {money(o.totalAmount)}
                    </Td>
                    <Td align="right">
                      <span
                        className={cx(
                          "text-[13px]",
                          waiting.urgent ? "text-danger" : "text-muted",
                        )}
                      >
                        {waiting.text}
                      </span>
                    </Td>
                    <Td align="right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setOpenId(o.orderId)}
                      >
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
            icon={<Icon name="check" size={24} className="text-success" />}
            title="Nothing waiting"
            body="Every order taken has been decided. New ones appear here the moment a telecaller logs them."
          />
        )}
      </Card>

      {open ? (
        <ReviewDrawer
          key={open.orderId}
          order={open}
          canApprove={canApprove}
          onClose={() => setOpenId(null)}
          onDecided={() => {
            setOpenId(null);
            router.refresh();
          }}
          run={run}
        />
      ) : null}
    </div>
  );
}

/**
 * Keyed on the order id by the caller, so opening a different order remounts
 * with fresh state rather than resetting it in an effect.
 */
function ReviewDrawer({
  order,
  canApprove,
  onClose,
  onDecided,
  run,
}: {
  order: PendingOrder;
  canApprove: boolean;
  onClose: () => void;
  onDecided: () => void;
  run: <T extends { ok: boolean; message?: string; error?: string }>(
    promise: Promise<T>,
  ) => Promise<T>;
}) {
  const [lines, setLines] = React.useState<Line[] | null>(null);
  const [declining, setDeclining] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/order-lines?orderId=${order.orderId}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : { lines: [] }))
      .then((d) => setLines(d.lines ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [order.orderId]);

  const risky = order.outstanding > 0 || order.overdueBills > 0 || order.slowPayer;

  return (
    <Drawer open onClose={onClose}>
      <DrawerHeader onClose={onClose}>
        <span className="block text-lg leading-6 font-semibold text-ink">
          {order.customerName}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-muted">
          {order.contactPerson} · {phoneDisplay(order.phone)} ·{" "}
          {order.customerCity}
        </span>
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {/* What accounts are actually here to check. Put first, because the
            line items are the thing you read after deciding the customer is
            good for it — not before. */}
        <SectionLabel>Can they take it</SectionLabel>
        <div
          className={cx(
            "mt-2 grid grid-cols-2 gap-3 rounded-[4px] border px-4 py-3",
            risky
              ? "border-warn-line bg-warn-soft"
              : "border-divider bg-canvas",
          )}
        >
          <Figure label="Outstanding" tone={order.outstanding > 0 ? "danger" : undefined}>
            {money(order.outstanding)}
          </Figure>
          <Figure label="Bills overdue" tone={order.overdueBills ? "danger" : undefined}>
            {order.overdueBills}
          </Figure>
          <Figure label="Payment term">
            {order.creditDays === null ? "Default" : `${order.creditDays} days`}
          </Figure>
          <Figure label="Pays on time" tone={order.slowPayer ? "warn" : undefined}>
            {order.slowPayer ? "Slow payer" : "No concerns"}
          </Figure>
        </div>

        <div className="mt-4 flex items-baseline justify-between">
          <SectionLabel>
            {order.lineCount} item{order.lineCount === 1 ? "" : "s"}
          </SectionLabel>
          <span className="text-[13px] text-muted">
            Taken by {order.takenByName ?? "—"} · {stamp(order.orderedAt)}
          </span>
        </div>

        <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-[4px] border border-line">
          {lines === null ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted">
              Loading the items…
            </p>
          ) : lines.length ? (
            lines.map((l, i) => (
              <div
                key={`${l.productName}:${i}`}
                className="flex items-center justify-between border-b border-divider px-3 py-2 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-body">
                  {l.packSize ? `${l.productName} — ${l.packSize}` : l.productName}
                </span>
                <span className="ml-3 text-sm font-medium text-ink">
                  × {l.quantity}
                </span>
              </div>
            ))
          ) : (
            <p className="px-3 py-6 text-center text-[13px] text-muted">
              No items recorded against this order.
            </p>
          )}
        </div>

        {declining ? (
          <div className="mt-4">
            <Field
              label="Why is it declined?"
              hint="The telecaller sees this and has to ring the customer back with it, so write something they can repeat."
            >
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-24"
                placeholder="Outstanding is over their limit — clear the June bills first."
              />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-5 py-3.5">
        {declining ? (
          <>
            <Button variant="secondary" onClick={() => setDeclining(false)}>
              Back
            </Button>
            <span className="flex-1" />
            <Button
              variant="danger"
              disabled={busy || !reason.trim()}
              title={reason.trim() ? undefined : "A reason is required"}
              onClick={async () => {
                setBusy(true);
                const r = await run(declineOrderAction(order.orderId, reason));
                setBusy(false);
                if (r.ok) onDecided();
              }}
            >
              Decline the order
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={!canApprove || busy}
              title={canApprove ? undefined : "Only the accounts team can decide on an order"}
              onClick={() => setDeclining(true)}
            >
              Decline
            </Button>
            <span className="flex-1" />
            <Button
              variant="primary"
              disabled={!canApprove || busy}
              title={canApprove ? undefined : "Only the accounts team can decide on an order"}
              onClick={async () => {
                setBusy(true);
                const r = await run(approveOrderAction(order.orderId));
                setBusy(false);
                if (r.ok) onDecided();
              }}
            >
              Approve {money(order.totalAmount)}
            </Button>
          </>
        )}
      </div>
    </Drawer>
  );
}

function Figure({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "danger" | "warn";
  children: React.ReactNode;
}) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span
        className={cx(
          "block text-sm font-medium",
          tone === "danger"
            ? "text-danger"
            : tone === "warn"
              ? "text-warn-ink"
              : "text-ink",
        )}
      >
        {children}
      </span>
    </span>
  );
}
