"use client";

/* ---------------------------------------------------------------------------
 * WHO IS ON A LIST AND WHO IS ON NONE — the list nobody wants to be long.
 *
 * A shop no scope names is a shop the order form prices at nothing: the
 * telecaller quotes from memory, the sheet bills whatever it bills, and the
 * variance report finds out a month later. So the unresolved customers are
 * named one by one with a way to fix each of them on the row, rather than
 * counted and left as a number somebody is expected to act on.
 *
 * The bars are RELATIVE TO THE BIGGEST list rather than to the book, because
 * the question they answer is which lists carry the weight — a bar against
 * 2,587 shops would draw every list as a sliver. A list naming NOBODY is
 * flagged: it is either scoped to a place with no shops in it or superseded
 * in fact and not in status, and both are worth somebody's eye.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  MetricStrip,
  Progress,
  Td,
  Th,
  Tr,
} from "@/components/ui/primitives";
import { LIST_STATUS_LABEL } from "@/lib/price-list-labels";
import type { CoverageReport, PricingOptions } from "@/lib/price-list-views";
import { AssignCustomerListModal } from "./modals/assign-customer-list-modal";

export function CoveragePanel({
  basePath,
  report,
  canManage,
  lists,
}: {
  basePath: string;
  report: CoverageReport;
  /** `pricelist.manage` — whether "Assign a list" is offered on a row. */
  canManage: boolean;
  lists: PricingOptions["lists"];
}) {
  const [assigning, setAssigning] = React.useState<{ id: string; name: string } | null>(null);

  const biggest = report.perList.reduce((max, l) => Math.max(max, l.customers), 0);

  return (
    <>
      <MetricStrip
        metrics={[
          { label: "Customers considered", value: report.customersConsidered.toLocaleString("en-IN") },
          { label: "On a list", value: report.resolved.toLocaleString("en-IN") },
          {
            label: "On no list",
            value: report.unresolved.toLocaleString("en-IN"),
            tone: report.unresolved ? "danger" : "ink",
          },
          {
            label: "Freight term not stated",
            value: report.noFreightTerm.toLocaleString("en-IN"),
            sub: "A list of either term can still name them",
          },
        ]}
      />

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Where the book sits" hint={`${report.perList.length} lists`} />
          {report.perList.length === 0 ? (
            <EmptyState
              title="No published list names anybody"
              body="Until a list has a scope on it, nothing can be priced from it."
            />
          ) : (
            <div className="space-y-3 px-5 py-4">
              {report.perList.map((l) => (
                <div key={l.listId}>
                  <div className="flex items-baseline justify-between gap-3">
                    <Link
                      href={`${basePath}/${l.listId}`}
                      className="truncate text-sm text-brand hover:underline"
                    >
                      {l.name}
                    </Link>
                    <span className="shrink-0 text-[13px] tabular-nums text-muted">
                      {l.customers.toLocaleString("en-IN")}{" "}
                      {l.customers === 1 ? "shop" : "shops"}
                    </span>
                  </div>
                  <Progress
                    className="mt-1.5"
                    value={biggest ? Math.round((l.customers / biggest) * 100) : 0}
                    tone={l.customers ? "brand" : "warn"}
                  />
                </div>
              ))}
            </div>
          )}

          {report.listsWithNobody.length ? (
            <div className="border-t border-divider px-5 py-4">
              <div className="mb-2 text-[13px] text-muted">
                Published and naming nobody — either scoped to a place with no shops in
                it, or superseded in fact and not in status.
              </div>
              <div className="flex flex-wrap gap-2">
                {report.listsWithNobody.map((l) => (
                  <Link key={l.id} href={`${basePath}/${l.id}`} className="hover:underline">
                    <Badge tone="warn" title={l.scopeSummary}>
                      {l.name} · {LIST_STATUS_LABEL[l.status]}
                    </Badge>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="On no list"
            hint={
              report.unresolvedCustomers.length < report.unresolved
                ? `showing ${report.unresolvedCustomers.length} of ${report.unresolved.toLocaleString("en-IN")}`
                : `${report.unresolved.toLocaleString("en-IN")}`
            }
          />
          <div className="px-5 pt-4">
            <Callout tone="warn">
              <span className="text-[13px] text-body">
                Unresolved means no scope on any published list names this shop — not that
                it was refused one. A single list scoped to <strong>Everybody</strong>
                {" "}catches every one of them at once, and anything narrower still beats it.
              </span>
            </Callout>
          </div>
          {report.unresolvedCustomers.length === 0 ? (
            <EmptyState
              title="Every shop is on a list"
              body="Nothing is being priced from memory."
            />
          ) : (
            <div className="max-h-[440px] overflow-auto">
              <table className="w-full min-w-[620px] border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th>City</Th>
                    <Th>Region</Th>
                    <Th>Freight</Th>
                    <Th>Salesman</Th>
                    {canManage ? <Th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {report.unresolvedCustomers.map((c) => (
                    <Tr key={c.id}>
                      <Td>{c.name}</Td>
                      <Td>{c.city || <span className="text-muted">not said</span>}</Td>
                      <Td>{c.region ?? <span className="text-muted">not said</span>}</Td>
                      <Td>
                        {c.freightTerm ?? <span className="text-muted">not stated</span>}
                      </Td>
                      <Td>{c.salesmanName ?? <span className="text-muted">nobody</span>}</Td>
                      {canManage ? (
                        <Td align="right">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setAssigning({ id: c.id, name: c.name })}
                          >
                            Assign a list
                          </Button>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {assigning ? (
        <AssignCustomerListModal
          open
          onClose={() => setAssigning(null)}
          customerId={assigning.id}
          customerName={assigning.name}
          lists={lists}
          currentListId={null}
        />
      ) : null}
    </>
  );
}
