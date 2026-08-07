"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  MetricStrip,
  MoneyInput,
  PageHeader,
  Progress,
  SectionLabel,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { setTarget, setTargetsBulk } from "@/lib/actions/crm";
import { money, moneyShort, pct, periodLabel } from "@/lib/format";

type Row = {
  customerId: string;
  customerName: string;
  ownerName: string | null;
  target: number;
  achieved: number;
  gap: number;
  percent: number;
  isDefault: boolean;
  cycleDays: number;
  contactsThisMonth: number;
};

type Classified = {
  customerId: string;
  name: string;
  gap: number;
  cycleDays: number;
  contactsThisMonth: number;
  expectedContacts: number;
};

type Shortfall = {
  coverageGap: Classified[];
  customerGap: Classified[];
  coverageGapValue: number;
  customerGapValue: number;
  totalShortfall: number;
} | null;

type Tab = "targets" | "shortfall";

export function TargetsScreen({
  scopeLabel,
  isManager,
  period,
  rows,
  shortfall,
}: {
  scopeLabel: string;
  isManager: boolean;
  period: string;
  rows: Row[];
  shortfall: Shortfall;
}) {
  const router = useRouter();
  const { run } = useToast();

  const [tab, setTab] = React.useState<Tab>("targets");
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [bulkOpen, setBulkOpen] = React.useState(false);

  const total = rows.reduce((a, r) => a + r.target, 0);
  const achieved = rows.reduce((a, r) => a + r.achieved, 0);
  const gap = Math.max(0, total - achieved);
  const percent = pct(achieved, total);
  const defaults = rows.filter((r) => r.isDefault).length;

  // The engine classifies the shortfall — the screen only lays it out. The
  // distinction is the point of the tab: a coverage gap is the telecaller's to
  // fix, a customer gap is a price, stock or terms conversation.
  const behind = rows.filter((r) => r.gap > 0);
  const groups: Array<{
    title: string;
    accent: string;
    blurb: string;
    rows: Classified[];
    value: number;
  }> = [
    {
      title: "Coverage gap",
      accent: "#B3261E",
      blurb:
        "Behind target and contacted less often than their own buying cycle implies. Call these before anything else.",
      rows: shortfall?.coverageGap ?? [],
      value: shortfall?.coverageGapValue ?? 0,
    },
    {
      title: "Customer gap",
      accent: "#B77B08",
      blurb:
        "Contacted often enough and the number still is not moving. Look at price, stock or terms.",
      rows: shortfall?.customerGap ?? [],
      value: shortfall?.customerGapValue ?? 0,
    },
  ];

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Monthly targets"
        subtitle={`${scopeLabel} · Per customer, per month. Where no target was set, a default is applied and marked.`}
        actions={
          <>
            <Select
              value={period}
              onChange={(e) => router.push(`/crm/targets?period=${e.target.value}`)}
              className="h-9"
            >
              {recentPeriods().map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={!isManager}
              title={isManager ? undefined : "Setting targets is a manager action"}
              onClick={() => setBulkOpen(true)}
            >
              Set targets in bulk
            </Button>
          </>
        }
      />

      <Card className="mb-4 flex items-center gap-8 px-5 py-4">
        <span>
          <SectionLabel>Target</SectionLabel>
          <span className="text-[22px] font-semibold text-ink">{money(total)}</span>
        </span>
        <span>
          <SectionLabel>Achieved</SectionLabel>
          <span className="text-[22px] font-semibold text-ink">{money(achieved)}</span>
        </span>
        <span>
          <SectionLabel>Gap</SectionLabel>
          <span
            className={cx(
              "text-[22px] font-semibold",
              gap ? "text-danger" : "text-success",
            )}
          >
            {money(gap)}
          </span>
        </span>
        <span className="flex max-w-[260px] flex-1 items-center gap-2.5">
          <Progress value={percent} className="flex-1" />
          <span className="text-[13px] font-medium text-ink">{percent}%</span>
        </span>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {defaults} customer{defaults === 1 ? "" : "s"} on an auto-applied default
        </span>
      </Card>

      <MetricStrip
        metrics={[
          { label: "Customers", value: String(rows.length) },
          { label: "On or above target", value: String(rows.filter((r) => r.percent >= 100).length), tone: "success" },
          { label: "Behind", value: String(behind.length), tone: behind.length ? "danger" : "ink" },
          {
            label: "Biggest single gap",
            value: behind.length ? moneyShort(Math.max(...behind.map((r) => r.gap))) : "-",
          },
        ]}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-4"
        tabs={[
          { key: "targets", label: "Targets", count: rows.length },
          { key: "shortfall", label: "Where the shortfall is", count: behind.length },
        ]}
      />

      {tab === "shortfall" ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] items-start gap-4">
          {groups.map((g) => (
            <Card key={g.title}>
              <div
                className="border-b border-divider border-l-[3px] px-5 py-4"
                style={{ borderLeftColor: g.accent }}
              >
                <div className="text-lg font-semibold text-ink">{g.title}</div>
                <div className="mt-1 text-[13px] text-muted">{g.blurb}</div>
                <div className="mt-3 flex gap-6">
                  <span>
                    <SectionLabel>Customers</SectionLabel>
                    <span className="text-[22px] font-semibold text-ink">
                      {g.rows.length}
                    </span>
                  </span>
                  <span>
                    <SectionLabel>Value shortfall</SectionLabel>
                    <span className="text-[22px] font-semibold text-danger">
                      {money(g.value)}
                    </span>
                  </span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th align="right">Shortfall</Th>
                    <Th align="right">Contacts</Th>
                    <Th align="right">Cycle</Th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.slice(0, 12).map((r) => (
                    <Tr key={r.customerId} className="hover:bg-canvas">
                      <Td className="font-medium text-ink">
                        <Link
                          href={`/crm/customers/${r.customerId}`}
                          className="no-underline hover:underline"
                        >
                          {r.name}
                        </Link>
                      </Td>
                      <Td align="right" className="font-medium text-danger">
                        {money(r.gap)}
                      </Td>
                      <Td align="right">
                        {r.contactsThisMonth} of {r.expectedContacts}
                      </Td>
                      <Td align="right">{r.cycleDays} days</Td>
                    </Tr>
                  ))}
                  {!g.rows.length ? (
                    <Tr>
                      <Td colSpan={4} className="py-8 text-center text-muted">
                        Nobody in this group.
                      </Td>
                    </Tr>
                  ) : null}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th align="right">Target</Th>
                <Th align="right">Achieved</Th>
                <Th align="right">Gap</Th>
                <Th>Achievement</Th>
                <Th>Owner</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.customerId} className="hover:bg-canvas">
                  <Td className="font-medium text-ink">
                    <Link
                      href={`/crm/customers/${r.customerId}`}
                      className="no-underline hover:underline"
                    >
                      {r.customerName}
                    </Link>
                    {r.isDefault ? (
                      <span className="ml-2">
                        <Badge tone="muted">Default</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right">{money(r.target)}</Td>
                  <Td align="right">{money(r.achieved)}</Td>
                  <Td align="right" className={r.gap ? "text-danger" : "text-success"}>
                    {money(r.gap)}
                  </Td>
                  <Td>
                    <span className="flex min-w-[160px] items-center gap-2.5">
                      <Progress
                        value={r.percent}
                        tone={r.percent >= 100 ? "success" : r.percent >= 60 ? "brand" : "danger"}
                        className="flex-1"
                      />
                      <span className="w-9 text-right text-[13px] text-body">
                        {r.percent}%
                      </span>
                    </span>
                  </Td>
                  <Td>{r.ownerName ?? "-"}</Td>
                  <Td align="right">
                    <span className="flex justify-end">
                      <RowMenu
                        items={[
                          {
                            label: "Set target",
                            onSelect: () => setEditing(r),
                            disabled: !isManager,
                            title: isManager ? undefined : "Manager action",
                          },
                          {
                            label: "Open customer record",
                            onSelect: () => router.push(`/crm/customers/${r.customerId}`),
                          },
                          {
                            label: "See their bills",
                            onSelect: () => router.push(`/crm/bills?customer=${r.customerId}`),
                          },
                        ]}
                      />
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <SetTargetModal
        row={editing}
        period={period}
        onClose={() => setEditing(null)}
        onSubmit={async (amount) => {
          if (!editing) return;
          const result = await run(setTarget(editing.customerId, amount, period));
          if (result.ok) {
            setEditing(null);
            router.refresh();
          }
        }}
      />

      <BulkTargetModal
        open={bulkOpen}
        count={rows.length}
        onClose={() => setBulkOpen(false)}
        onSubmit={async (mode, value, onlyDefaults) => {
          const ids = (onlyDefaults ? rows.filter((r) => r.isDefault) : rows).map(
            (r) => r.customerId,
          );
          const result = await run(
            setTargetsBulk({ customerIds: ids, mode, value, period }),
          );
          if (result.ok) {
            setBulkOpen(false);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

function recentPeriods(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 6; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

type SetTargetProps = {
  row: Row | null;
  period: string;
  onClose: () => void;
  onSubmit: (amount: string) => Promise<void>;
};

function SetTargetModal(props: SetTargetProps) {
  if (!props.row) return null;
  return <SetTargetModalBody key={props.row.customerId} {...props} />;
}

function SetTargetModalBody({ row, period, onClose, onSubmit }: SetTargetProps) {
  const [amount, setAmount] = React.useState(
    String(Math.round((row?.target ?? 0) / 100)),
  );
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title={`Set target · ${row?.customerName ?? ""}`}
      width={440}
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
                await onSubmit(amount);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save target
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">
        {periodLabel(period)} · achieved so far {money(row?.achieved ?? 0)}
      </div>
      <Field
        label="Monthly target"
        hint={
          row?.isDefault
            ? "This customer is currently on the auto-applied default. Saving replaces it with a real number."
            : undefined
        }
      >
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
    </Modal>
  );
}

function BulkTargetModal({
  open,
  count,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onSubmit: (
    mode: "amount" | "uplift",
    value: string,
    onlyDefaults: boolean,
  ) => Promise<void>;
}) {
  const [mode, setMode] = React.useState<"amount" | "uplift">("uplift");
  const [value, setValue] = React.useState("10");
  const [onlyDefaults, setOnlyDefaults] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set targets in bulk"
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
                await onSubmit(mode, value, onlyDefaults);
              } finally {
                setBusy(false);
              }
            }}
          >
            Apply targets
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="How to set them">
          <Select
            value={mode}
            onChange={(e) => {
              const next = e.target.value as "amount" | "uplift";
              setMode(next);
              setValue(next === "uplift" ? "10" : "100000");
            }}
          >
            <option value="uplift">Uplift on each customer&apos;s own run rate</option>
            <option value="amount">The same flat amount for everyone</option>
          </Select>
        </Field>

        {mode === "uplift" ? (
          <Field
            label="Uplift %"
            hint="Applied to the customer's average order spread over a month - so a big account gets a big target."
          >
            <Input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-[140px]"
            />
          </Field>
        ) : (
          <Field label="Target for each customer">
            <MoneyInput value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            checked={onlyDefaults}
            onChange={(e) => setOnlyDefaults(e.target.checked)}
            className="h-[15px] w-[15px] accent-[#6835FB]"
          />
          Only customers still on the auto-applied default
        </label>

        <div className="rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
          This overwrites existing targets for the customers it touches
          {onlyDefaults
            ? " - with the box ticked, only the untouched defaults change."
            : `, all ${count} of them.`}
        </div>
      </div>
    </Modal>
  );
}
