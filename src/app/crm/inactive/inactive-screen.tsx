"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  PageHeader,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Modal,
  RowMenu,
  SelectionBar,
} from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  createRemindersBulk,
  decideDeactivation,
  requestDeactivation,
} from "@/lib/actions/crm";
import { toCsv, downloadCsv } from "@/lib/csv";
import { ageLabel, money, shortDate, today } from "@/lib/format";

import type { WatchRow as Row } from "@/lib/services/worklist-services";

export function InactiveScreen({
  scopeLabel,
  isManager,
  rows,
}: {
  scopeLabel: string;
  isManager: boolean;
  rows: Row[];
}) {
  const router = useRouter();
  const { run, push } = useToast();

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [remindOpen, setRemindOpen] = React.useState(false);
  const [deactOpen, setDeactOpen] = React.useState(false);

  const atRisk = rows.reduce((a, r) => a + r.valueAtRisk, 0);
  const stale = rows.filter((r) => r.ageDays > 14).length;
  const pending = rows.filter((r) => r.deactivationRequested).length;

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="max-w-[1400px] px-6 pt-6 pb-10">
      <PageHeader
        title="Inactive watch"
        subtitle={`${scopeLabel} · Customers who have gone at least twice their own buying cycle without ordering.`}
        actions={
          <Button
            variant="secondary"
            disabled={!isManager}
            title={isManager ? "Download as CSV" : "Export is a manager action"}
            onClick={() => {
              downloadCsv(
                "mahek-inactive",
                toCsv(
                  ["Customer", "City", "Last order", "Days since", "Normal cycle", "Elapsed", "Value at risk (₹)", "Days without a decision"],
                  rows.map((r) => [
                    r.name,
                    r.city,
                    r.lastOrderDate ?? "",
                    r.daysSinceLastOrder,
                    r.cycleDays,
                    `${Number(r.cyclesElapsed)}×`,
                    Math.round(r.valueAtRisk / 100),
                    r.ageDays,
                  ]),
                ),
              );
              push(`Exported ${rows.length} rows`);
            }}
          >
            Export
          </Button>
        }
      />

      <MetricStrip
        metrics={[
          { label: "On the watch", value: String(rows.length) },
          { label: "Value at risk", value: money(atRisk), tone: atRisk ? "danger" : "ink" },
          {
            label: "No decision in 2 weeks",
            value: String(stale),
            tone: stale ? "danger" : "ink",
            sub: "these are the ones that quietly leave",
          },
          { label: "Deactivation pending", value: String(pending) },
          {
            label: "Deepest lapse",
            value: rows.length ? `${Math.max(...rows.map((r) => Number(r.cyclesElapsed)))}×` : "—",
          },
        ]}
      />

      <Card className="overflow-auto">
        {rows.length ? (
          <table>
            <thead>
              <tr>
                <Th className="w-9">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="accent-[#6835FB]"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.customerId)) : new Set())
                    }
                  />
                </Th>
                <Th>Customer</Th>
                <Th>Last order</Th>
                <Th align="right">Days since</Th>
                <Th align="right">Normal cycle</Th>
                <Th>Elapsed</Th>
                <Th align="right">Value at risk</Th>
                <Th>Last contact</Th>
                <Th align="right">Age without decision</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.customerId} className="hover:bg-canvas">
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      className="accent-[#6835FB]"
                      checked={selected.has(r.customerId)}
                      onChange={() => toggle(r.customerId)}
                    />
                  </Td>
                  <Td className="font-medium text-ink">
                    <Link href={`/crm/customers/${r.customerId}`} className="no-underline hover:underline">
                      {r.name}
                    </Link>
                    {r.deactivationRequested ? (
                      <span className="ml-2">
                        <Badge tone="warn">Deactivation asked</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>{r.lastOrderDate ? shortDate(r.lastOrderDate) : "Never"}</Td>
                  <Td align="right">{r.daysSinceLastOrder}</Td>
                  <Td align="right">{r.cycleDays} days</Td>
                  <Td>
                    <Badge tone={Number(r.cyclesElapsed) >= 3 ? "danger" : "warn"}>{Number(r.cyclesElapsed)}×</Badge>
                  </Td>
                  <Td align="right" className="font-medium text-ink">
                    {money(r.valueAtRisk)}
                  </Td>
                  <Td>{r.lastContactDate ? shortDate(r.lastContactDate) : "—"}</Td>
                  <Td
                    align="right"
                    className={cx(
                      r.ageDays > 14 ? "font-medium text-danger" : "",
                    )}
                  >
                    {ageLabel(r.ageDays)}
                  </Td>
                  <Td align="right">
                    <span className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => router.push(`/crm/customers/${r.customerId}`)}
                      >
                        Call now
                      </Button>
                      <RowMenu
                        items={[
                          {
                            label: "Send a reorder nudge",
                            onSelect: () => router.push(`/crm/whatsapp?customer=${r.customerId}`),
                          },
                          {
                            label: "See their bills",
                            onSelect: () => router.push(`/crm/bills?customer=${r.customerId}`),
                          },
                          ...(isManager && r.deactivationRequested
                            ? [
                                {
                                  label: "Approve deactivation",
                                  destructive: true,
                                  onSelect: async () => {
                                    await run(decideDeactivation(r.customerId, true));
                                    router.refresh();
                                  },
                                },
                                {
                                  label: "Reject the request",
                                  onSelect: async () => {
                                    await run(decideDeactivation(r.customerId, false));
                                    router.refresh();
                                  },
                                },
                              ]
                            : [
                                {
                                  label: "Request deactivation",
                                  destructive: true,
                                  onSelect: () => {
                                    setSelected(new Set([r.customerId]));
                                    setDeactOpen(true);
                                  },
                                },
                              ]),
                        ]}
                      />
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="Nobody has gone quiet"
            body="Every customer in this book has ordered inside twice their normal buying cycle. That is what good looks like."
          />
        )}
      </Card>

      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button variant="dark" size="sm" onClick={() => setRemindOpen(true)}>
          Set reminders
        </Button>
        <Button variant="dark" size="sm" onClick={() => setDeactOpen(true)}>
          Request deactivation
        </Button>
      </SelectionBar>

      <BulkRemind
        open={remindOpen}
        count={selected.size}
        onClose={() => setRemindOpen(false)}
        onSubmit={async (dueDate, note) => {
          const result = await run(createRemindersBulk([...selected], dueDate, note));
          if (result.ok) {
            setRemindOpen(false);
            setSelected(new Set());
            router.refresh();
          }
        }}
      />

      <ConfirmDialog
        open={deactOpen}
        title={`Request deactivation for ${selected.size} customer${selected.size === 1 ? "" : "s"}?`}
        body="A manager decides. Until then they stay in the book and on this watch, so nothing goes missing while the request sits."
        confirmLabel="Request deactivation"
        destructive
        needsReason
        onClose={() => setDeactOpen(false)}
        onConfirm={async (reason) => {
          const result = await run(requestDeactivation([...selected], reason));
          if (result.ok) {
            setSelected(new Set());
            router.refresh();
          }
        }}
      />
    </div>
  );
}

function BulkRemind({
  open,
  count,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onSubmit: (dueDate: string, note: string) => Promise<void>;
}) {
  const [dueDate, setDueDate] = React.useState(today());
  const [note, setNote] = React.useState("Win-back call — they have gone past their cycle");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Set reminders on ${count} customer${count === 1 ? "" : "s"}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(dueDate, note);
              } finally {
                setBusy(false);
              }
            }}
          >
            Set reminders
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Due date · required">
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-[200px]"
          />
        </Field>
        <Field label="What the reminder says · required">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-20"
          />
        </Field>
      </div>
    </Modal>
  );
}
