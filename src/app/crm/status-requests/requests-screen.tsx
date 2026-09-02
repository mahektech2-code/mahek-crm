"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { decideDeactivation, decideReactivation } from "@/lib/actions/crm";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  MetricStrip,
  PageHeader,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { longDate, money } from "@/lib/format";
import { addDays } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * ONE QUEUE FOR BOTH DIRECTIONS.
 *
 * A request to close a customer and a request to bring one back are the same
 * act — somebody asking a manager to change a customer's status and waiting for
 * an answer — so they are one list with a column saying which, rather than two
 * screens somebody has to remember to visit. Splitting them would guarantee the
 * quieter one goes unread, and reactivation is by far the quieter one.
 *
 * Before this, Approve and Reject lived only on the Inactive Watch: a list of
 * customers who had gone QUIET. A request for anybody else — a customer closing
 * down who ordered last week, a duplicate record — was notified, badged on the
 * customer list, and had no screen a manager could act on it from. Six of them
 * had been waiting.
 * ------------------------------------------------------------------------- */

export type Row = {
  customerId: string;
  customerName: string;
  kind: "deactivate" | "reactivate";
  reason: string | null;
  askedBy: string | null;
  askedOn: string | null;
  assignedTo: string | null;
  status: string;
  outstanding: number;
  lastOrderDate: string | null;
};

type Pending = { row: Row; approve: boolean } | null;

export function RequestsScreen({ rows, today }: { rows: Row[]; today: string }) {
  const router = useRouter();
  const { run } = useToast();
  const [pending, setPending] = React.useState<Pending>(null);
  const [busy, setBusy] = React.useState(false);

  const deactivations = rows.filter((r) => r.kind === "deactivate");
  const owing = deactivations.filter((r) => r.outstanding > 0);

  return (
    // The wrapper every CRM screen brings. `<main>` in the app shell has no
    // padding of its own — deliberately, so a screen can run edge to edge if it
    // needs to — which means a screen that forgets this one sits flush against
    // the sidebar. `max-w-[1440px]` matches Inactive Watch, the table-shaped
    // sibling this queue was pulled out of.
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Customer status requests"
        subtitle="Asked for by whoever works the account, closed or reopened here. Nothing on this list has changed a customer's status yet."
      />

      <MetricStrip
        metrics={[
          { label: "Waiting", value: String(rows.length) },
          { label: "To close", value: String(deactivations.length) },
          {
            label: "To reopen",
            value: String(rows.length - deactivations.length),
          },
          {
            // The number that should change how carefully this list is read.
            // Closing an account that still owes money does not write the debt
            // off — the bills stay, and so does the balance — but it does take
            // the customer out of the collections worklist, so nobody will
            // chase it again.
            label: "Owing money",
            value: String(owing.length),
            tone: owing.length ? "danger" : undefined,
          },
        ]}
      />

      <Card className="overflow-auto">
        <CardHeader
          title="Waiting to be closed or reopened"
          hint="Oldest first — the longest wait is the one somebody has been waiting on"
        />

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            body="When somebody asks for a customer account to be closed, or for a closed one to be reopened, it appears here and everyone who can decide is notified."
          />
        ) : (
          <table>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Asked for</Th>
                  <Th>Reason</Th>
                  <Th>Asked by</Th>
                  <Th align="right">Outstanding</Th>
                  <Th align="right">Last order</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <Tr key={`${r.kind}-${r.customerId}`} className={i % 2 === 1 ? "bg-canvas" : undefined}>
                    <Td>
                      <Link
                        href={`/crm/customers/${r.customerId}`}
                        className="font-medium text-ink"
                      >
                        {r.customerName}
                      </Link>
                      <span className="mt-px block text-[13px] text-muted">
                        {/* Whose call it is, in words rather than blank — a
                            customer nobody owns is the one a manager most needs
                            to see. */}
                        {r.assignedTo ?? "Nobody assigned"}
                      </span>
                    </Td>

                    <Td>
                      {r.kind === "deactivate" ? (
                        <Badge tone="danger">Close the account</Badge>
                      ) : (
                        <Badge tone="success">Bring it back</Badge>
                      )}
                    </Td>

                    <Td className="max-w-[280px]">
                      <span className="block text-pretty text-body">
                        {r.reason ?? "No reason recorded"}
                      </span>
                    </Td>

                    <Td>
                      {/* Null on the requests raised before the asker was
                          stored. Saying so beats inventing a name, and the
                          notification that carried it is still findable. */}
                      {r.askedBy ?? <span className="text-muted">Not recorded</span>}
                      <span className="mt-px block text-[13px] text-muted">
                        {r.askedOn ? longDate(r.askedOn) : "date not recorded"}
                      </span>
                    </Td>

                    <Td align="right">
                      <span
                        className={cx(
                          "tabular-nums",
                          r.outstanding > 0 ? "font-medium text-warn-ink" : "text-muted",
                        )}
                      >
                        {r.outstanding > 0 ? money(r.outstanding) : "—"}
                      </span>
                    </Td>

                    <Td align="right">
                      <span className="tabular-nums text-muted">
                        {r.lastOrderDate ? longDate(r.lastOrderDate) : "never"}
                      </span>
                    </Td>

                    <Td align="right">
                      <span className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPending({ row: r, approve: true })}
                          className="h-8 cursor-pointer rounded-[4px] border border-brand bg-brand px-3 text-[13px] font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPending({ row: r, approve: false })}
                          className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
          </table>
        )}
      </Card>

      {/*
        Keyed on the row and the direction, so opening it for a second request
        starts fresh rather than inheriting the last one's state — the same
        reason every modal here is keyed instead of reset in an effect.
      */}
      {pending ? (
        <ConfirmDialog
          key={`${pending.row.customerId}-${pending.approve}`}
          open
          onClose={() => setPending(null)}
          destructive={pending.approve && pending.row.kind === "deactivate"}
          title={confirmTitle(pending)}
          body={confirmBody(pending, today)}
          confirmLabel={pending.approve ? "Yes, do it" : "Reject the request"}
          onConfirm={async () => {
            setBusy(true);
            const { row, approve } = pending;
            const result = await run(
              row.kind === "deactivate"
                ? decideDeactivation(row.customerId, approve)
                : decideReactivation(row.customerId, approve),
            );
            setBusy(false);
            if (result.ok) {
              setPending(null);
              router.refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

function confirmTitle({ row, approve }: NonNullable<Pending>): string {
  if (!approve) return `Reject the request for ${row.customerName}?`;
  return row.kind === "deactivate"
    ? `Close ${row.customerName}'s account?`
    : `Bring ${row.customerName} back?`;
}

/**
 * What actually happens, said before it happens — and the two facts that most
 * often change the answer said with it.
 */
function confirmBody({ row, approve }: NonNullable<Pending>, today: string): string {
  if (!approve) {
    return `Nothing changes about ${row.customerName}. The request leaves this list, and whoever asked will need to be told why.`;
  }

  if (row.kind === "reactivate") {
    return `${row.customerName} goes back to active and returns to the calling queue on their own buying cycle. The deactivation reason on the record is cleared.`;
  }

  const parts = [
    `${row.customerName} is marked deactivated. Nothing is deleted — every call, order and bill stays queryable — but they leave the calling queue, the collections worklist and the inactive watch.`,
  ];
  if (row.outstanding > 0) {
    parts.push(
      `They still owe ${money(row.outstanding)}. That debt is not written off, and the bills remain on their record, but nobody will be prompted to chase it again.`,
    );
  }
  if (row.lastOrderDate && row.lastOrderDate >= addDays(today, -30)) {
    parts.push(
      `They last ordered on ${longDate(row.lastOrderDate)}, which is inside the last month.`,
    );
  }
  return parts.join(" ");
}
