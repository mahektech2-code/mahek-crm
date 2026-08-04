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
  Select,
  SlowPayerBadge,
  Td,
  Th,
  Textarea,
  Tr,
} from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Modal,
  RowMenu,
  SelectionBar,
} from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import {
  createCustomer,
  createRemindersBulk,
  requestDeactivation,
  updateCustomer,
} from "@/lib/actions/crm";
import { money, phoneDisplay, shortDate, stamp, today } from "@/lib/format";
import { toCsv, downloadCsv } from "@/lib/csv";

type Row = {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  city: string;
  ownerId: string | null;
  ownerName: string | null;
  kind: "lead" | "customer";
  leadSource: string | null;
  salesAmName: string | null;
  backOfficeAmName: string | null;
  status: string;
  lastOrderDate: string | null;
  lastContactAt: string | null;
  outstanding: number;
  slowPayer: boolean;
  openComplaints: number;
  gstin: string | null;
  creditTermDays: number;
  cycleDays: number;
  route: string | null;
  deactivationRequested: boolean;
};

const STATUSES = ["All statuses", "Active", "Slow payer", "Inactive", "New"];

export function CustomersScreen({
  scopeLabel,
  isManager,
  team,
  rows,
}: {
  scopeLabel: string;
  isManager: boolean;
  team: Array<{ id: string; name: string }>;
  rows: Row[];
}) {
  const router = useRouter();
  const { run, push } = useToast();

  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState(STATUSES[0]);
  const [owner, setOwner] = React.useState("All owners");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [bulkRemind, setBulkRemind] = React.useState(false);
  const [deactivating, setDeactivating] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== STATUSES[0] && r.status !== status) return false;
      if (owner !== "All owners" && r.ownerName !== owner) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.contactPerson.toLowerCase().includes(q) ||
        r.phone.includes(q) ||
        r.city.toLowerCase().includes(q)
      );
    });
  }, [rows, query, status, owner]);

  const chips = [
    status !== STATUSES[0]
      ? { label: `Status: ${status}`, clear: () => setStatus(STATUSES[0]) }
      : null,
    owner !== "All owners"
      ? { label: `Owner: ${owner}`, clear: () => setOwner("All owners") }
      : null,
    query ? { label: `Search: ${query}`, clear: () => setQuery("") } : null,
  ].filter(Boolean) as Array<{ label: string; clear: () => void }>;

  function clearAll() {
    setQuery("");
    setStatus(STATUSES[0]);
    setOwner("All owners");
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportCsv(subset: Row[]) {
    if (!isManager) {
      push("Export is a manager action.", "error");
      return;
    }
    downloadCsv(
      "mahek-customers",
      toCsv(
        [
          "Customer",
          "Contact",
          "Phone",
          "City",
          "Type",
          "Owner",
          "Sales AM",
          "Back office AM",
          "Lead source",
          "Status",
          "Last order",
          "Outstanding (₹)",
        ],
        subset.map((r) => [
          r.name,
          r.contactPerson,
          r.phone,
          r.city,
          r.kind === "lead" ? "Lead" : "Customer",
          r.ownerName ?? "",
          r.salesAmName ?? "",
          r.backOfficeAmName ?? "",
          r.leadSource ?? "",
          r.status,
          r.lastOrderDate ?? "",
          Math.round(r.outstanding / 100),
        ]),
      ),
      [
        status === STATUSES[0] ? null : status,
        owner === "All owners" ? null : owner,
        query || null,
      ],
    );
    push(`Exported ${subset.length} rows`);
  }

  const totalOutstanding = filtered.reduce((a, r) => a + r.outstanding, 0);
  const slow = filtered.filter((r) => r.slowPayer).length;
  const withComplaints = filtered.filter((r) => r.openComplaints > 0).length;

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Customers"
        subtitle={`${scopeLabel} · Every account in the book, with the figures a telecaller needs mid-call.`}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={!isManager}
              title={
                isManager ? "Download as CSV" : "Export is a manager action"
              }
              onClick={() => exportCsv(filtered)}
            >
              Export
            </Button>
            {isManager ? (
              <Link
                href="/crm/customers/import"
                className="inline-flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Import CSV
              </Link>
            ) : null}
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Add lead
            </Button>
          </>
        }
      />

      <MetricStrip
        metrics={[
          {
            label: "Customers",
            value: String(filtered.length),
            sub: `of ${rows.length} in the book`,
          },
          {
            label: "Outstanding",
            value: money(totalOutstanding),
            tone: totalOutstanding > 0 ? "danger" : "ink",
          },
          {
            label: "Slow payers",
            value: String(slow),
            tone: slow ? "danger" : "ink",
          },
          { label: "With open complaints", value: String(withComplaints) },
          {
            label: "Average outstanding",
            value: money(
              filtered.length
                ? Math.round(totalOutstanding / filtered.length)
                : 0,
            ),
          },
        ]}
      />

      <Card className="mb-0 flex items-center gap-2.5 rounded-b-none border-b-0 px-4 py-3">
        <div className="relative w-[300px]">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute top-2 left-2.5 text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, contact, phone, city"
            className="h-8 w-full rounded-[4px] border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute top-1.5 right-1.5 h-4.5 w-4.5 cursor-pointer text-muted"
            >
              ×
            </button>
          ) : null}
        </div>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8"
        >
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <Select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="h-8"
        >
          <option>All owners</option>
          {team.map((t) => (
            <option key={t.id}>{t.name}</option>
          ))}
        </Select>
        {chips.length ? (
          <button
            onClick={clearAll}
            className="h-8 cursor-pointer px-2.5 text-sm text-brand"
          >
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {filtered.length} of {rows.length}
        </span>
      </Card>

      {chips.length ? (
        <div className="flex flex-wrap gap-2 border-r border-l border-line bg-surface px-4 pb-3">
          {chips.map((c) => (
            <button
              key={c.label}
              onClick={c.clear}
              className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-canvas px-2 text-[13px] text-body"
            >
              {c.label} <span className="text-muted">×</span>
            </button>
          ))}
        </div>
      ) : null}

      <Card className="overflow-auto rounded-t-none">
        {filtered.length ? (
          <table>
            <thead>
              <tr>
                <Th className="w-9">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="accent-[#6835FB]"
                    checked={
                      filtered.length > 0 && selected.size === filtered.length
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(filtered.map((r) => r.id))
                          : new Set(),
                      )
                    }
                  />
                </Th>
                <Th>Customer</Th>
                <Th>Contact person</Th>
                <Th>Phone</Th>
                <Th>Type</Th>
                <Th>Owner / account managers</Th>
                <Th>Status</Th>
                <Th>Last order</Th>
                <Th>Last contact</Th>
                <Th align="right">Outstanding</Th>
                <Th>City</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <Tr key={r.id} className="hover:bg-canvas">
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      className="accent-[#6835FB]"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </Td>
                  <Td className="font-medium text-ink">
                    <Link
                      href={`/crm/customers/${r.id}`}
                      className="no-underline hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.slowPayer ? (
                      <span className="ml-2">
                        <SlowPayerBadge />
                      </span>
                    ) : null}
                    {r.deactivationRequested ? (
                      <span className="ml-2">
                        <Badge tone="warn">Deactivation asked</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>{r.contactPerson}</Td>
                  <Td>{phoneDisplay(r.phone)}</Td>
                  <Td>
                    <Badge tone={r.kind === "lead" ? "brand" : "neutral"}>
                      {r.kind === "lead" ? "Lead" : "Customer"}
                    </Badge>
                  </Td>
                  {/* Two lines, because a customer answers to two people and a
                      lead to one. Flattening them into a single name would hide
                      whichever one you did not pick. */}
                  <Td>
                    <span className="block text-sm text-body">
                      {r.kind === "lead"
                        ? (r.ownerName ?? "Unassigned")
                        : (r.salesAmName ?? r.ownerName ?? "Unassigned")}
                    </span>
                    <span className="block text-xs text-muted">
                      {r.kind === "lead"
                        ? (r.leadSource ?? "Source not recorded")
                        : `Back office: ${r.backOfficeAmName ?? "unassigned"}`}
                    </span>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        r.status === "Slow payer"
                          ? "warn"
                          : r.status === "Inactive"
                            ? "muted"
                            : r.status === "New"
                              ? "brand"
                              : "success"
                      }
                    >
                      {r.status}
                    </Badge>
                  </Td>
                  <Td>{r.lastOrderDate ? shortDate(r.lastOrderDate) : "—"}</Td>
                  <Td>{r.lastContactAt ? stamp(r.lastContactAt) : "—"}</Td>
                  <Td
                    align="right"
                    className={
                      r.outstanding > 0 ? "font-medium text-danger" : ""
                    }
                  >
                    {money(r.outstanding)}
                  </Td>
                  <Td>{r.city}</Td>
                  <Td align="right">
                    <span className="flex justify-end">
                      <RowMenu
                        items={[
                          {
                            label: "Open record",
                            onSelect: () =>
                              router.push(`/crm/customers/${r.id}`),
                          },
                          {
                            label: "Edit details",
                            onSelect: () => setEditing(r),
                          },
                          {
                            label: "Send WhatsApp",
                            onSelect: () =>
                              router.push(`/crm/whatsapp?customer=${r.id}`),
                          },
                          {
                            label: "See their bills",
                            onSelect: () =>
                              router.push(`/crm/bills?customer=${r.id}`),
                          },
                          {
                            label: "Request deactivation",
                            destructive: true,
                            onSelect: () => {
                              setSelected(new Set([r.id]));
                              setDeactivating(true);
                            },
                          },
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
            title="No customers match these filters"
            body="Widen the search or clear the filters to see the full book."
            action={
              <Button variant="primary" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        )}
      </Card>

      <SelectionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
      >
        <Button variant="dark" size="sm" onClick={() => setBulkRemind(true)}>
          Set reminder
        </Button>
        <Button
          variant="dark"
          size="sm"
          onClick={() => {
            const first = [...selected][0];
            router.push(`/crm/whatsapp?customer=${first}`);
          }}
        >
          Send WhatsApp
        </Button>
        <Button
          variant="dark"
          size="sm"
          disabled={!isManager}
          title={isManager ? undefined : "Export is a manager action"}
          onClick={() => exportCsv(filtered.filter((r) => selected.has(r.id)))}
        >
          Export
        </Button>
        <Button variant="dark" size="sm" onClick={() => setDeactivating(true)}>
          Request deactivation
        </Button>
      </SelectionBar>

      <CustomerForm
        open={addOpen}
        title="Add lead"
        team={team}
        onClose={() => setAddOpen(false)}
        onSubmit={async (values) => {
          const result = await run(createCustomer(values));
          if (result.ok) {
            setAddOpen(false);
            router.refresh();
          }
          return result.ok;
        }}
      />

      <CustomerForm
        open={Boolean(editing)}
        title={`Edit ${editing?.name ?? ""}`}
        team={team}
        initial={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSubmit={async (values) => {
          if (!editing) return false;
          const result = await run(updateCustomer(editing.id, values));
          if (result.ok) {
            setEditing(null);
            router.refresh();
          }
          return result.ok;
        }}
      />

      <BulkReminderModal
        open={bulkRemind}
        count={selected.size}
        onClose={() => setBulkRemind(false)}
        onSubmit={async (dueDate, note) => {
          const result = await run(
            createRemindersBulk([...selected], dueDate, note),
          );
          if (result.ok) {
            setBulkRemind(false);
            setSelected(new Set());
            router.refresh();
          }
        }}
      />

      <ConfirmDialog
        open={deactivating}
        title={`Request deactivation for ${selected.size} customer${selected.size === 1 ? "" : "s"}?`}
        body="They stay visible until a manager approves it. The reason is kept on the customer record either way."
        confirmLabel="Request deactivation"
        destructive
        needsReason
        onClose={() => setDeactivating(false)}
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

type CustomerFormProps = {
  open: boolean;
  title: string;
  team: Array<{ id: string; name: string }>;
  initial?: Partial<Row>;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>;
};

/** Keyed on the customer so editing one never leaks fields into the next. */
function CustomerForm(props: CustomerFormProps) {
  if (!props.open) return null;
  return <CustomerFormBody key={props.initial?.id ?? "new"} {...props} />;
}

function CustomerFormBody({
  open,
  title,
  team,
  initial,
  onClose,
  onSubmit,
}: CustomerFormProps) {
  const [busy, setBusy] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({
    name: initial?.name ?? "",
    contactPerson: initial?.contactPerson ?? "",
    phone: initial?.phone ?? "",
    city: initial?.city ?? "",
    ownerId: initial?.ownerId ?? team[0]?.id ?? "",
    gstin: initial?.gstin ?? "",
    creditTermDays: String(initial?.creditTermDays ?? 30),
    cycleDays: String(initial?.cycleDays ?? 30),
    route: initial?.route ?? "",
  });

  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((v) => ({ ...v, [k]: e.target.value }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={560}
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
                await onSubmit(values);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Business name · required" className="col-span-2">
          <Input
            value={values.name ?? ""}
            onChange={set("name")}
            placeholder="As it appears on the bill"
          />
        </Field>
        <Field label="Contact person · required">
          <Input
            value={values.contactPerson ?? ""}
            onChange={set("contactPerson")}
          />
        </Field>
        <Field label="Telephone · required" hint="10 digits, no country code">
          <Input
            value={values.phone ?? ""}
            onChange={set("phone")}
            inputMode="numeric"
            maxLength={10}
          />
        </Field>
        <Field label="City · required">
          <Input value={values.city ?? ""} onChange={set("city")} />
        </Field>
        <Field label="Owner">
          <Select value={values.ownerId ?? ""} onChange={set("ownerId")}>
            {team.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="GSTIN">
          <Input value={values.gstin ?? ""} onChange={set("gstin")} />
        </Field>
        <Field label="Route">
          <Input value={values.route ?? ""} onChange={set("route")} />
        </Field>
        <Field label="Credit terms (days)">
          <Input
            type="number"
            value={values.creditTermDays ?? ""}
            onChange={set("creditTermDays")}
          />
        </Field>
        <Field
          label="Buying cycle (days)"
          hint="Twice this without an order puts them on the inactive watch"
        >
          <Input
            type="number"
            value={values.cycleDays ?? ""}
            onChange={set("cycleDays")}
          />
        </Field>
      </div>
    </Modal>
  );
}

function BulkReminderModal({
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
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Set a reminder on ${count} customer${count === 1 ? "" : "s"}`}
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
        <Field
          label="What is the reminder for · required"
          hint="Every selected customer gets this same note — write it so it still makes sense in a week."
        >
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-20"
            placeholder="Follow up on the month-end order"
          />
        </Field>
      </div>
    </Modal>
  );
}
