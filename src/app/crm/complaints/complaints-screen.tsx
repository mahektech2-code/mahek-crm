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
  Input,
  MetricStrip,
  PageHeader,
  Radio,
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
import { logComplaint, reassignComplaint, resolveComplaint } from "@/lib/actions/crm";
import { ageLabel, money, shortDate, stamp } from "@/lib/format";
import { ImagePicker } from "@/components/crm/image-picker";
import { CN_STATUS_LABEL, categoryLabel } from "@/lib/complaint-labels";

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

  const buckets = {
    open: rows.filter((r) => r.status === "open"),
    progress: rows.filter(
      (r) => r.status === "in_progress" || r.status === "awaiting_customer",
    ),
    resolved: rows.filter((r) => CLOSED.includes(r.status)),
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
                  className="no-underline hover:underline"
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
                <Badge tone={current.severity === "critical" || current.severity === "high" ? "danger" : "neutral"}>
                  {current.severity}
                </Badge>
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

      <LogComplaintModal
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

type LogComplaintInput = {
  customerId: string;
  category: string;
  description: string;
  mobileNumber: string;
  requestCn: boolean;
  images: File[];
};

type CustomerHit = { id: string; name: string; city: string; phone: string };

function LogComplaintModal({
  open,
  onClose,
  categories,
  maxImages,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  categories: string[];
  maxImages: number;
  onSubmit: (input: LogComplaintInput) => Promise<void>;
}) {
  if (!open) return null;
  return (
    <LogComplaintModalBody
      categories={categories}
      maxImages={maxImages}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function LogComplaintModalBody({
  categories,
  maxImages,
  onClose,
  onSubmit,
}: {
  categories: string[];
  maxImages: number;
  onClose: () => void;
  onSubmit: (input: LogComplaintInput) => Promise<void>;
}) {
  const [customerQuery, setCustomerQuery] = React.useState("");
  const [customerHits, setCustomerHits] = React.useState<CustomerHit[]>([]);
  const [customer, setCustomer] = React.useState<
    { id: string; name: string; phone: string } | null
  >(null);
  const [category, setCategory] = React.useState<string>(categories[0] ?? "Other");
  const [description, setDescription] = React.useState("");
  const [images, setImages] = React.useState<File[]>([]);
  const [requestCn, setRequestCn] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{
    customer?: string;
    description?: string;
  }>({});

  const searchActive = !customer && customerQuery.trim().length >= 2;

  // Stale hits from a previous query must never show once search is inactive.
  const visibleHits = searchActive ? customerHits : [];

  React.useEffect(() => {
    if (!searchActive) return;
    const term = customerQuery.trim();
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          setCustomerHits(data.customers ?? []);
        }
      } catch {
        /* aborted */
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [customerQuery, searchActive]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Log complaint"
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (!customer) {
                setErrors({ customer: "Pick the customer this complaint is about." });
                return;
              }
              if (!description.trim()) {
                setErrors({
                  description: "Describe the complaint in the customer's words.",
                });
                return;
              }
              setErrors({});
              setBusy(true);
              try {
                await onSubmit({
                  customerId: customer.id,
                  category,
                  description,
                  mobileNumber: customer.phone,
                  requestCn,
                  images,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Company / Customer Name" error={errors.customer ?? null}>
          {customer ? (
            <div className="flex h-8.5 items-center justify-between rounded-[4px] border border-line bg-canvas px-2.5 text-sm text-ink">
              <span>{customer.name}</span>
              <button
                type="button"
                className="cursor-pointer text-[13px] text-muted hover:text-ink"
                onClick={() => {
                  setCustomer(null);
                  setCustomerQuery("");
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="relative">
              <Input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Search by company, customer name or mobile number…"
              />
              {visibleHits.length ? (
                <div className="absolute top-9 right-0 left-0 z-10 max-h-48 overflow-auto rounded-[6px] border border-line bg-surface py-1 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
                  {visibleHits.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
                      onClick={() => {
                        setCustomer({ id: c.id, name: c.name, phone: c.phone });
                        setCustomerHits([]);
                        setCustomerQuery("");
                      }}
                    >
                      <span className="text-sm font-medium text-ink">{c.name}</span>
                      <span className="text-[13px] text-muted">{c.city}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </Field>

        <Field label="Mobile number">
          <Input
            value={customer?.phone ?? ""}
            readOnly
            disabled
            placeholder="Pick a customer first"
          />
        </Field>

        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>

        <Field
          label="Complaint description"
          error={errors.description ?? null}
        >
          <VoiceTextarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setErrors({});
            }}
            onDictate={(v) => {
              setDescription(v);
              setErrors({});
            }}
            className="h-24"
            placeholder="Describe the complaint in detail."
          />
        </Field>

        <ImagePicker files={images} onChange={setImages} max={maxImages} />

        <Field
          label="Request CN"
          hint={
            requestCn
              ? "Accounts take it from here - they pick up the bill and the amount."
              : undefined
          }
        >
          <div className="flex items-center gap-4">
            <Radio
              name="requestCn"
              label="No"
              checked={!requestCn}
              onChange={() => setRequestCn(false)}
            />
            <Radio
              name="requestCn"
              label="Yes"
              checked={requestCn}
              onChange={() => setRequestCn(true)}
            />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
