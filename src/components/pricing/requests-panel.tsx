"use client";

/* ---------------------------------------------------------------------------
 * WHO HAS ASKED FOR A DIFFERENT PRICE, and what came of it.
 *
 * One screen rendered in two apps, like the customers list beside it: the CRM
 * links a row into the customer record and the Sales Dashboard has no such
 * page, so the name is plain text there. Two screens reading the same table
 * would be two answers to one question.
 *
 * The delta is the column somebody actually reads. A rate in rupees says
 * nothing on its own — a hundred rupees off a 2,300 can and off a 300 can are
 * different conversations — so the percent is beside it and drawn in danger
 * where it is BELOW what the shop pays today, which is the direction that
 * costs money.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Card, EmptyState, Td, Th, Tr } from "@/components/ui/primitives";
import { ConfirmDialog, FilterPills, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, stamp } from "@/lib/format";
import { REQUEST_STATUS_LABEL } from "@/lib/price-list-labels";
import { withdrawPriceRequest } from "@/lib/actions/price-lists";
import type { RequestView } from "@/lib/price-list-views";
import { DecideRequestModal } from "./modals/decide-request-modal";

const STATUS_TONE: Record<RequestView["status"], "warn" | "success" | "danger" | "muted"> = {
  pending: "warn",
  approved: "success",
  refused: "danger",
  withdrawn: "muted",
};

export function RequestsPanel({
  app,
  basePath,
  canManage,
  currentUserId,
  requests,
  todayIso,
}: {
  app: "sales" | "crm";
  /** Where this app's price lists live, for links out of the table. */
  basePath: string;
  /** `pricelist.manage` — whether Decide is offered. The action checks again. */
  canManage: boolean;
  /** Only the person who asked may withdraw, so the menu has to know who is reading. */
  currentUserId: string;
  requests: RequestView[];
  todayIso: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [filter, setFilter] = React.useState<"pending" | "all">("pending");
  const [deciding, setDeciding] = React.useState<RequestView | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<RequestView | null>(null);

  const pending = requests.filter((r) => r.status === "pending");
  const rows = filter === "pending" ? pending : requests;

  return (
    <>
      <div className="mb-4">
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "pending", label: "Waiting", count: pending.length },
            { key: "all", label: "All", count: requests.length },
          ]}
        />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={filter === "pending" ? "Nothing waiting" : "Nobody has asked for a special price"}
            body={
              filter === "pending"
                ? "Every request has been decided. Switch to All to read what was agreed."
                : "A request is raised from a customer's record, on the call where the shop asks."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Product</Th>
                  <Th align="right">They pay now</Th>
                  <Th align="right">Asking for</Th>
                  <Th align="right">Delta</Th>
                  <Th>Why</Th>
                  <Th>Asked by</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const current = r.currentRateExGstPaise;
                  const delta =
                    current && current > 0
                      ? Math.round(
                          ((r.requestedRateExGstPaise - current) / current) * 1000,
                        ) / 10
                      : null;
                  const items = [
                    ...(canManage && r.status === "pending"
                      ? [{ label: "Decide", onSelect: () => setDeciding(r) }]
                      : []),
                    ...(r.status === "pending" && r.requestedById === currentUserId
                      ? [
                          {
                            label: "Withdraw",
                            destructive: true,
                            onSelect: () => setWithdrawing(r),
                          },
                        ]
                      : []),
                  ];
                  return (
                    <Tr key={r.id}>
                      <Td>
                        {app === "crm" ? (
                          <Link
                            href={`/crm/customers/${r.customerId}`}
                            className="text-brand hover:underline"
                          >
                            {r.customerName}
                          </Link>
                        ) : (
                          r.customerName
                        )}
                        {r.currentListName ? (
                          <div className="text-[12px] text-muted">
                            {r.currentListId ? (
                              <Link
                                href={`${basePath}/${r.currentListId}`}
                                className="hover:underline"
                              >
                                {r.currentListName}
                              </Link>
                            ) : (
                              r.currentListName
                            )}
                          </div>
                        ) : (
                          <div className="text-[12px] text-muted">no list resolves</div>
                        )}
                      </Td>
                      <Td>{r.productName}</Td>
                      <Td align="right">
                        {current == null ? (
                          <span className="text-muted">not on a list</span>
                        ) : (
                          <>
                            {money(current)}
                            <div className="text-[12px] text-muted">ex-GST</div>
                          </>
                        )}
                      </Td>
                      <Td align="right">
                        {money(r.requestedRateExGstPaise)}
                        <div className="text-[12px] text-muted">
                          {money(r.requestedRateInclGstPaise)} incl
                        </div>
                      </Td>
                      <Td align="right">
                        {delta == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span className={delta < 0 ? "text-danger" : "text-success"}>
                            {delta > 0 ? "+" : ""}
                            {delta}%
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className="block max-w-[260px] truncate" title={r.reason}>
                          {r.reason}
                        </span>
                        {r.decisionNote ? (
                          <span
                            className="block max-w-[260px] truncate text-[12px] text-muted"
                            title={r.decisionNote}
                          >
                            {r.decidedByName ?? "Decided"}: {r.decisionNote}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {r.requestedByName}
                        <div className="text-[12px] text-muted">{stamp(r.requestedAt)}</div>
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONE[r.status]}>
                          {REQUEST_STATUS_LABEL[r.status]}
                        </Badge>
                      </Td>
                      <Td align="right">{items.length ? <RowMenu items={items} /> : null}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {deciding ? (
        <DecideRequestModal
          open
          request={deciding}
          todayIso={todayIso}
          onClose={() => setDeciding(null)}
        />
      ) : null}

      <ConfirmDialog
        open={!!withdrawing}
        title="Withdraw this request?"
        body={
          withdrawing
            ? `${withdrawing.customerName} — ${withdrawing.productName}. Nobody will decide it. You can ask again.`
            : ""
        }
        confirmLabel="Withdraw"
        destructive
        onClose={() => setWithdrawing(null)}
        onConfirm={async () => {
          if (!withdrawing) return;
          const r = await run(withdrawPriceRequest(withdrawing.id));
          setWithdrawing(null);
          if (r.ok) router.refresh();
        }}
      />
    </>
  );
}
