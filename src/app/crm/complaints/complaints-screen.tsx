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
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, Tabs } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import {
  logComplaint,
  reassignComplaint,
  resolveComplaint,
  setComplaintPriorityAction,
} from "@/lib/actions/crm";
import { ageLabel, money, shortDate, stamp } from "@/lib/format";
import { LogComplaintDialog } from "@/components/crm/log-complaint-dialog";
import {
  CN_STATUS_LABEL,
  COMPLAINT_PRIORITIES,
  categoryLabel,
  isEscalatedPriority,
  priorityLabel,
} from "@/lib/complaint-labels";

type Status =
  | "open"
  | "in_progress"
  | "awaiting_customer"
  | "resolved"
  | "closed"
  | "rejected";

type Row = {
  id: string;
  customerId: string;
  customerName: string;
  category: string;
  description: string;
  loggedByName: string;
  createdAt: Date;
  assignedTo: string;
  severity: "low" | "medium" | "high" | "critical";
  status: Status;
  ageDays: number;
  slaDueAt: Date;
  slaBreached: boolean;
  resolutionNotes: string | null;
  customerInformed: boolean;
  mobileNumber: string | null;
  requestCn: boolean;
  cnStatus: string | null;
  cnAmount: number | null;
  cnReference: string | null;
  goodsDescription: string | null;
  resolvedAt: Date | null;
};

/** A photograph on a complaint. The bytes come from /api/attachments/[id]. */
type Attachment = { id: string; filename: string; isImage: boolean };

const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  in_progress: "In progress",
  awaiting_customer: "Awaiting customer",
  resolved: "Resolved",
  closed: "Closed",
  rejected: "Rejected",
};

const CLOSED: Status[] = ["resolved", "closed", "rejected"];

function statusTone(s: Status) {
  if (CLOSED.includes(s)) return "success" as const;
  return s === "open" ? ("danger" as const) : ("warn" as const);
}

type Event = { at: string; note: string };
type Tab = "open" | "progress" | "resolved" | "all";

const RESOLVERS = ["Operations", "Accounts", "Dispatch", "Quality", "Management"];

/** One line of the drawer's detail grid. A blank reads as a gap, not a zero. */
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">{children || <span className="text-muted">—</span>}</dd>
    </>
  );
}

/**
 * The photographs on a complaint.
 *
 * They were uploaded and then unreachable: nothing in the CRM had ever
 * displayed an attachment, so a telecaller could send six pictures of damaged
 * stock into the database and no screen would show them to whoever had to act
 * on it. Every thumbnail opens the real file through /api/attachments/[id],
 * which is the only route that serves bytes, because it is the one that checks
 * the caller can see the complaint.
 */
function Photographs({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <>
      <SectionLabel>
        Photographs · {items.length}
      </SectionLabel>
      <div className="mt-1.5 mb-5 flex flex-wrap gap-2">
        {items.map((a) => (
          <a
            key={a.id}
            href={`/api/attachments/${a.id}`}
            target="_blank"
            rel="noreferrer"
            title={a.filename}
            className="block"
          >
            {a.isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/attachments/${a.id}`}
                alt={a.filename}
                className="h-16 w-16 rounded-[4px] border border-line object-cover"
              />
            ) : (
              <span className="flex h-16 w-16 items-center justify-center rounded-[4px] border border-line bg-canvas px-1 text-center text-[11px] break-all text-muted">
                {a.filename.slice(0, 18)}
              </span>
            )}
          </a>
        ))}
      </div>
    </>
  );
}

export function ComplaintsScreen({
  scopeLabel,
  isManager,
  isTeamView,
  rows,
  events,
  attachments,
  categories,
  maxImages,
}: {
  scopeLabel: string;
  isManager: boolean;
  isTeamView: boolean;
  rows: Row[];
  events: Record<string, Event[]>;
  /** Photographs per complaint, read with the rows rather than per drawer. */
  attachments: Record<string, Attachment[]>;
  /** From configuration, so a manager can change the list without a deploy. */
  categories: string[];
  /** `attachments.maxPerComplaint`, so the screen and the server agree. */
  maxImages: number;
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
  const [logging, setLogging] = React.useState(false);

  /*
   * THE BUCKETS AND THE AGE STRIP, IN ONE PASS, MEMOISED ON THE ROWS.
   *
   * Three filters built the buckets, three more counted the age strip over a
   * concatenation of two of them, and one more counted "customer told" — seven
   * walks of the list on every render, and this screen re-renders on every
   * dialog open and every keystroke inside one. Only `rows` can change any of
   * it.
   *
   * `visible` is one of these arrays, so the identity matters as much as the
   * arithmetic: a fresh array on every render is a new prop for the table
   * below it.
   */
  const buckets = React.useMemo(() => {
    const open: Row[] = [];
    const progress: Row[] = [];
    const resolved: Row[] = [];
    for (const r of rows) {
      if (r.status === "open") open.push(r);
      else if (r.status === "in_progress" || r.status === "awaiting_customer") {
        progress.push(r);
      }
      if (CLOSED.includes(r.status)) resolved.push(r);
    }
    return { open, progress, resolved, all: rows };
  }, [rows]);
  const visible = buckets[tab];

  const { stillOpen, ageBuckets } = React.useMemo(() => {
    const open = [...buckets.open, ...buckets.progress];
    let under3 = 0;
    let three7 = 0;
    let over7 = 0;
    for (const r of open) {
      if (r.ageDays < 3) under3++;
      else if (r.ageDays <= 7) three7++;
      else over7++;
    }
    return {
      stillOpen: open,
      ageBuckets: [
        { label: "under 3 days", n: under3, tone: "success" as const },
        { label: "3 to 7 days", n: three7, tone: "warn" as const },
        { label: "over 7 days", n: over7, tone: "danger" as const },
      ],
    };
  }, [buckets]);
  const oldest = stillOpen.reduce<Row | null>(
    (a, r) => (!a || r.ageDays > a.ageDays ? r : a),
    null,
  );

  function open(row: Row) {
    setCurrent(row);
    setNotes(row.resolutionNotes ?? "");
    setTold(row.customerInformed);
    setNotesError(false);
  }

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Complaints"
        subtitle={`${scopeLabel} · Logged at the point they are raised, routed to a resolver, visible on the customer record.`}
        actions={
          <Button variant="primary" onClick={() => setLogging(true)}>
            Log complaint
          </Button>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Open", value: String(buckets.open.length), tone: buckets.open.length ? "danger" : "ink" },
          { label: "In progress", value: String(buckets.progress.length) },
          { label: "Resolved", value: String(buckets.resolved.length), tone: "success" },
          {
            label: "Oldest open",
            value: oldest ? ageLabel(oldest.ageDays) : "-",
            tone: oldest && oldest.ageDays > 7 ? "danger" : "ink",
            sub: oldest?.customerName,
          },
          {
            label: "Customer told",
            value: `${buckets.resolved.filter((r) => r.customerInformed).length}/${buckets.resolved.length}`,
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
                    <Td>{categoryLabel(r.category)}</Td>
                    <Td className="max-w-[340px] truncate text-muted" title={r.description}>
                      {r.description}
                    </Td>
                    <Td>{r.loggedByName}</Td>
                    <Td>{shortDate(r.createdAt.toISOString())}</Td>
                    <Td>{r.assignedTo}</Td>
                    <Td>
                      <Badge
                        tone={
                          r.status === "open"
                            ? "danger"
                            : r.status === "in_progress"
                              ? "warn"
                              : "success"
                        }
                      >
                        {STATUS_LABEL[r.status]}
                      </Badge>
                    </Td>
                    <Td
                      align="right"
                      className={
                        !CLOSED.includes(r.status) && r.slaBreached
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
            body="Complaints logged on a call will appear here until they are closed."
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
                  className="no-underline"
                >
                  {current.customerName}
                </Link>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <Badge
                  tone={statusTone(current.status)}
                >
                  {STATUS_LABEL[current.status]}
                </Badge>
                <Badge tone={current.slaBreached ? "danger" : "neutral"}>
                  {current.slaBreached ? "SLA breached" : `SLA ${stamp(current.slaDueAt.toISOString())}`}
                </Badge>
                {/* The stored severity is not a label either — this printed
                  * `medium` at a manager, which is the database's word and not
                  * the business's. Normal, Urgent, Critical.
                  *
                  * A SELECT rather than a badge, because the priority is the
                  * judgement most likely to be made LATE: the person who took
                  * the call had a sentence, and whoever opens this has the
                  * story. Changing it moves the resolution deadline with it —
                  * see `setComplaintPriority`. Closed complaints keep the
                  * badge: there is no deadline left to move. */}
                {CLOSED.includes(current.status) ? (
                  <Badge tone={isEscalatedPriority(current.severity) ? "danger" : "neutral"}>
                    {priorityLabel(current.severity)}
                  </Badge>
                ) : (
                  <Select
                    aria-label="Priority"
                    value={current.severity}
                    disabled={busy}
                    className={cx(
                      "h-6 w-auto py-0 pr-6 pl-2 text-[11px] font-medium",
                      isEscalatedPriority(current.severity)
                        ? "border-danger text-danger"
                        : undefined,
                    )}
                    onChange={async (e) => {
                      const next = e.target.value;
                      setBusy(true);
                      const result = await run(
                        setComplaintPriorityAction(current.id, next),
                      );
                      setBusy(false);
                      if (result.ok) {
                        // The drawer holds its own copy of the row, so the
                        // badge under the cursor has to move before the
                        // refresh lands or it reads as a click that did
                        // nothing.
                        setCurrent({ ...current, severity: next as Row["severity"] });
                        router.refresh();
                      }
                    }}
                  >
                    {COMPLAINT_PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                )}
                <span className="text-[13px] text-muted">
                  {categoryLabel(current.category)} · open {ageLabel(current.ageDays)}
                </span>
              </div>
            </DrawerHeader>

            <div className="flex-1 overflow-y-auto p-5">
              <SectionLabel>Complaint</SectionLabel>
              <dl className="mt-1.5 mb-5 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                <Detail label="Raised by">{current.loggedByName}</Detail>
                <Detail label="Raised">{stamp(current.createdAt.toISOString())}</Detail>
                <Detail label="Category">{categoryLabel(current.category)}</Detail>
                <Detail label="Mobile">{current.mobileNumber}</Detail>
                <Detail label="With">{current.assignedTo}</Detail>
                <Detail label="Goods">{current.goodsDescription}</Detail>
                <Detail label="Credit note">
                  {current.requestCn ? (
                    <span className="text-ink">
                      Requested
                      {current.cnStatus && current.cnStatus !== "requested"
                        ? ` · ${CN_STATUS_LABEL[current.cnStatus] ?? current.cnStatus}`
                        : ""}
                      {current.cnAmount ? ` · ${money(current.cnAmount)}` : ""}
                      {current.cnReference ? ` · ${current.cnReference}` : ""}
                    </span>
                  ) : (
                    "Not asked for"
                  )}
                </Detail>
              </dl>

              <SectionLabel>What the customer reported</SectionLabel>
              <p className="mt-1 mb-5 text-sm leading-[21px] text-ink">
                {current.description}
              </p>

              <Photographs items={attachments[current.id] ?? []} />

              <SectionLabel>Status history</SectionLabel>
              <div className="mt-2">
                {(events[current.id] ?? []).map((e, i) => (
                  <div key={i} className="border-b border-canvas py-2 last:border-0">
                    <div className="text-[11px] text-muted">{stamp(e.at)}</div>
                    <div className="mt-0.5 text-sm text-body">{e.note}</div>
                  </div>
                ))}
              </div>

              {CLOSED.includes(current.status) ? (
                <div className="mt-5">
                  <SectionLabel>How it was resolved</SectionLabel>
                  <p className="mt-1 text-sm leading-[21px] text-ink">
                    {current.resolutionNotes || "Closed without a note."}
                  </p>
                  <p className="mt-1.5 text-[13px] text-muted">
                    {current.resolvedAt ? `${stamp(current.resolvedAt.toISOString())} · ` : ""}
                    {current.customerInformed
                      ? "The customer was told the outcome."
                      : "The customer has NOT been told the outcome."}
                  </p>
                </div>
              ) : (
                <>
                  <Field
                    label="Resolution notes · required to close"
                    className="mt-5"
                    error={
                      notesError
                        ? "Write what was done before closing - this is what the customer record will show."
                        : null
                    }
                  >
                    <VoiceTextarea
                      value={notes}
                      onChange={(e) => {
                        setNotes(e.target.value);
                        setNotesError(false);
                      }}
                      onDictate={(v) => {
                        setNotes(v);
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
                </>
              )}
            </div>

            <div className="flex gap-2.5 border-t border-line px-5 py-3">
              <Button
                variant="primary"
                disabled={busy || !isManager || CLOSED.includes(current.status)}
                title={
                  !isManager
                    ? "Closing a complaint is a manager action"
                    : CLOSED.includes(current.status)
                      ? "Already resolved"
                      : undefined
                }
                onClick={async () => {
                  if (!notes.trim()) {
                    setNotesError(true);
                    return;
                  }
                  setBusy(true);
                  // `finally`: `run` re-throws, and a flag cleared only on the
                  // way past the await disables this button for good.
                  try {
                    const result = await run(
                      resolveComplaint({
                        id: current.id,
                        resolutionNote: notes,
                        customerTold: told,
                      }),
                    );
                    if (result.ok) {
                      setCurrent(null);
                      router.refresh();
                    }
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {CLOSED.includes(current.status) ? "Resolved" : "Mark resolved"}
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

      <LogComplaintDialog
        open={logging}
        onClose={() => setLogging(false)}
        categories={categories}
        maxImages={maxImages}
        onSubmit={async (input) => {
          const result = await run(logComplaint(input));
          if (result.ok) {
            setLogging(false);
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
