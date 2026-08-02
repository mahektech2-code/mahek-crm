"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  MetricStrip,
  PageHeader,
  SectionLabel,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { reassignComplaint, resolveComplaint } from "@/lib/actions/crm";
import { ageLabel, shortDate, stamp } from "@/lib/format";

type Row = {
  id: string;
  customerId: string;
  customerName: string;
  category: string;
  description: string;
  loggedByName: string;
  loggedOn: string;
  assignedTo: string;
  status: "Open" | "In progress" | "Resolved" | "Closed";
  ageDays: number;
  resolutionNote: string | null;
  customerTold: boolean;
};

type Event = { at: string; note: string };
type Tab = "open" | "progress" | "resolved" | "all";

const RESOLVERS = ["Operations", "Accounts", "Dispatch", "Quality", "Management"];

export function ComplaintsScreen({
  scopeLabel,
  isManager,
  isTeamView,
  rows,
  events,
}: {
  scopeLabel: string;
  isManager: boolean;
  isTeamView: boolean;
  rows: Row[];
  events: Record<string, Event[]>;
}) {
  const router = useRouter();
  const { run } = useToast();

  const [tab, setTab] = React.useState<Tab>("open");
  const [current, setCurrent] = React.useState<Row | null>(null);
  const [notes, setNotes] = React.useState("");
  const [told, setTold] = React.useState(false);
  const [notesError, setNotesError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [reassigning, setReassigning] = React.useState(false);

  const buckets = {
    open: rows.filter((r) => r.status === "Open"),
    progress: rows.filter((r) => r.status === "In progress"),
    resolved: rows.filter((r) => r.status === "Resolved" || r.status === "Closed"),
    all: rows,
  };
  const visible = buckets[tab];

  const stillOpen = [...buckets.open, ...buckets.progress];
  const ageBuckets = [
    { label: "under 3 days", n: stillOpen.filter((r) => r.ageDays < 3).length, tone: "success" as const },
    { label: "3 to 7 days", n: stillOpen.filter((r) => r.ageDays >= 3 && r.ageDays <= 7).length, tone: "warn" as const },
    { label: "over 7 days", n: stillOpen.filter((r) => r.ageDays > 7).length, tone: "danger" as const },
  ];
  const oldest = stillOpen.reduce<Row | null>(
    (a, r) => (!a || r.ageDays > a.ageDays ? r : a),
    null,
  );

  function open(row: Row) {
    setCurrent(row);
    setNotes(row.resolutionNote ?? "");
    setTold(row.customerTold);
    setNotesError(false);
  }

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Complaints"
        subtitle={`${scopeLabel} · Logged at the point they are raised, routed to a resolver, visible on the customer record.`}
      />

      <MetricStrip
        metrics={[
          { label: "Open", value: String(buckets.open.length), tone: buckets.open.length ? "danger" : "ink" },
          { label: "In progress", value: String(buckets.progress.length) },
          { label: "Resolved", value: String(buckets.resolved.length), tone: "success" },
          {
            label: "Oldest open",
            value: oldest ? ageLabel(oldest.ageDays) : "—",
            tone: oldest && oldest.ageDays > 7 ? "danger" : "ink",
            sub: oldest?.customerName,
          },
          {
            label: "Customer told",
            value: `${buckets.resolved.filter((r) => r.customerTold).length}/${buckets.resolved.length}`,
          },
        ]}
      />

      {isTeamView && stillOpen.length ? (
        <Card className="mb-4 flex items-center gap-8 px-5 py-3.5">
          <SectionLabel>Open complaints by age</SectionLabel>
          {ageBuckets.map((b) => (
            <span key={b.label} className="flex items-baseline gap-2">
              <span
                className={cx(
                  "block h-2 w-2 self-center rounded-full",
                  b.tone === "danger"
                    ? "bg-danger"
                    : b.tone === "warn"
                      ? "bg-warn"
                      : "bg-success",
                )}
              />
              <span
                className={cx(
                  "text-lg font-semibold",
                  b.tone === "danger" ? "text-danger" : "text-ink",
                )}
              >
                {b.n}
              </span>
              <span className="text-[13px] text-muted">{b.label}</span>
            </span>
          ))}
          <span className="flex-1" />
          {oldest ? (
            <span className="text-[13px] text-muted">
              Oldest open: {oldest.customerName} · {ageLabel(oldest.ageDays)}
            </span>
          ) : null}
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <Tabs
          value={tab}
          onChange={setTab}
          className="px-5"
          tabs={[
            { key: "open", label: "Open", count: buckets.open.length },
            { key: "progress", label: "In progress", count: buckets.progress.length },
            { key: "resolved", label: "Resolved", count: buckets.resolved.length },
            { key: "all", label: "All", count: rows.length },
          ]}
        />

        {visible.length ? (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Category</Th>
                  <Th>Description</Th>
                  <Th>Logged by</Th>
                  <Th>Logged</Th>
                  <Th>Assigned to</Th>
                  <Th>Status</Th>
                  <Th align="right">Age</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <Tr
                    key={r.id}
                    onClick={() => open(r)}
                    className="cursor-pointer hover:bg-canvas"
                  >
                    <Td className="font-medium text-ink">{r.customerName}</Td>
                    <Td>{r.category}</Td>
                    <Td className="max-w-[340px] truncate text-muted" title={r.description}>
                      {r.description}
                    </Td>
                    <Td>{r.loggedByName}</Td>
                    <Td>{shortDate(r.loggedOn)}</Td>
                    <Td>{r.assignedTo}</Td>
                    <Td>
                      <Badge
                        tone={
                          r.status === "Open"
                            ? "danger"
                            : r.status === "In progress"
                              ? "warn"
                              : "success"
                        }
                      >
                        {r.status}
                      </Badge>
                    </Td>
                    <Td
                      align="right"
                      className={
                        r.status !== "Resolved" && r.ageDays > 7
                          ? "font-medium text-danger"
                          : ""
                      }
                    >
                      {ageLabel(r.ageDays)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No complaints in this tab"
            body="Complaints logged on a call appear here until they are closed."
          />
        )}
      </Card>

      <Drawer
        open={Boolean(current)}
        onClose={() => setCurrent(null)}
        width={480}
        label="Complaint"
      >
        {current ? (
          <>
            <DrawerHeader onClose={() => setCurrent(null)}>
              <div className="text-lg font-semibold text-ink">
                <Link
                  href={`/crm/customers/${current.customerId}`}
                  className="no-underline hover:underline"
                >
                  {current.customerName}
                </Link>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <Badge
                  tone={
                    current.status === "Open"
                      ? "danger"
                      : current.status === "In progress"
                        ? "warn"
                        : "success"
                  }
                >
                  {current.status}
                </Badge>
                <span className="text-[13px] text-muted">
                  {current.category} · open {ageLabel(current.ageDays)}
                </span>
              </div>
            </DrawerHeader>

            <div className="flex-1 overflow-y-auto p-5">
              <SectionLabel>What the customer reported</SectionLabel>
              <p className="mt-1 mb-5 text-sm leading-[21px] text-ink">
                {current.description}
              </p>

              <SectionLabel>Status history</SectionLabel>
              <div className="mt-2">
                {(events[current.id] ?? []).map((e, i) => (
                  <div key={i} className="border-b border-canvas py-2 last:border-0">
                    <div className="text-[11px] text-muted">{stamp(e.at)}</div>
                    <div className="mt-0.5 text-sm text-body">{e.note}</div>
                  </div>
                ))}
              </div>

              <Field
                label="Resolution notes · required to close"
                className="mt-5"
                error={
                  notesError
                    ? "Write what was done before closing — this is what the customer record will show."
                    : null
                }
              >
                <Textarea
                  value={notes}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    setNotesError(false);
                  }}
                  invalid={notesError}
                  className="h-24"
                  placeholder="What was done to close this"
                />
              </Field>

              <Checkbox
                label="The customer has been told the outcome"
                checked={told}
                onChange={(e) => setTold(e.target.checked)}
                className="mt-3"
              />
            </div>

            <div className="flex gap-2.5 border-t border-line px-5 py-3">
              <Button
                variant="primary"
                disabled={busy || !isManager || current.status === "Resolved"}
                title={
                  !isManager
                    ? "Closing a complaint is a manager action"
                    : current.status === "Resolved"
                      ? "Already resolved"
                      : undefined
                }
                onClick={async () => {
                  if (!notes.trim()) {
                    setNotesError(true);
                    return;
                  }
                  setBusy(true);
                  const result = await run(
                    resolveComplaint({
                      id: current.id,
                      resolutionNote: notes,
                      customerTold: told,
                    }),
                  );
                  setBusy(false);
                  if (result.ok) {
                    setCurrent(null);
                    router.refresh();
                  }
                }}
              >
                {current.status === "Resolved" ? "Resolved" : "Mark resolved"}
              </Button>
              <Button variant="secondary" onClick={() => setReassigning(true)}>
                Reassign
              </Button>
            </div>
          </>
        ) : null}
      </Drawer>

      <ReassignModal
        open={reassigning}
        current={current?.assignedTo ?? RESOLVERS[0]}
        onClose={() => setReassigning(false)}
        onSubmit={async (to) => {
          if (!current) return;
          const result = await run(reassignComplaint(current.id, to));
          if (result.ok) {
            setReassigning(false);
            setCurrent(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

type ReassignProps = {
  open: boolean;
  current: string;
  onClose: () => void;
  onSubmit: (to: string) => Promise<void>;
};

function ReassignModal(props: ReassignProps) {
  if (!props.open) return null;
  return <ReassignModalBody key={props.current} {...props} />;
}

function ReassignModalBody({ open, current, onClose, onSubmit }: ReassignProps) {
  const [to, setTo] = React.useState(current);
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reassign complaint"
      width={420}
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
                await onSubmit(to);
              } finally {
                setBusy(false);
              }
            }}
          >
            Reassign
          </Button>
        </>
      }
    >
      <Field
        label="Send it to"
        hint="Reassigning moves the complaint to In progress and is recorded in the history."
      >
        <Select value={to} onChange={(e) => setTo(e.target.value)}>
          {RESOLVERS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}
