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
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  ENQUIRY_STAGES,
  ENQUIRY_PRIORITIES,
  STAGE_LABEL,
  PRIORITY_LABEL,
  STAGE_TONE,
  PRIORITY_TONE,
  ACTIVITY_LABEL,
  type EnquiryStage,
  type EnquiryPriority,
} from "@/lib/enquiry-labels";
import { phoneDisplay, stamp, money, shortDateWithYear, today } from "@/lib/format";
import type { EnquirySubmissionFields } from "@/lib/enquiry-submission";
import { otherSubmissionFields } from "@/lib/enquiry-submission";
import type { EnquiryDetail, AssignableUser, PossibleDuplicate, OrderCandidate } from "@/lib/services/enquiry-service";
import {
  assignEnquiryAction,
  changeStageAction,
  changePriorityAction,
  linkCustomerAction,
  addNoteAction,
  createEnquiryReminderAction,
  linkOrderAction,
  unlinkOrderAction,
  findCustomersByPhoneAction,
} from "@/lib/actions/enquiries";
import type { CustomerMatch } from "@/lib/services/enquiry-service";
import type { Result } from "@/lib/result";

type Tab = "overview" | "timeline" | "followup" | "orders";

export function EnquiryDetailScreen({
  enquiry,
  submission,
  team,
  duplicates,
  orderCandidates,
}: {
  enquiry: EnquiryDetail;
  submission: EnquirySubmissionFields;
  team: AssignableUser[];
  duplicates: PossibleDuplicate[];
  orderCandidates: OrderCandidate[];
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  const router = useRouter();
  const { run } = useToast();

  async function after(p: Promise<Result>) {
    await run(p);
    router.refresh();
  }

  const displayName = enquiry.customerName ?? submission.name ?? "Unknown";
  const displayPhone = enquiry.customerPhone ?? submission.phone;

  return (
    <div className="max-w-[1200px] px-6 pt-6 pb-10">
      <Link
        href="/enquiries/list"
        className="mb-2.5 inline-flex items-center gap-1.5 text-[13px] text-muted no-underline hover:no-underline hover:text-body"
      >
        ← All enquiries
      </Link>

      <div className="mb-1 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] leading-[30px] font-semibold text-ink">{displayName}</h1>
          <div className="mt-0.5 text-[13px] text-muted">
            {submission.company ? `${submission.company} · ` : ""}
            {displayPhone ? phoneDisplay(displayPhone) : "No phone given"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={STAGE_TONE[enquiry.stage]}>{STAGE_LABEL[enquiry.stage]}</Badge>
            <Badge tone={PRIORITY_TONE[enquiry.priority]}>{PRIORITY_LABEL[enquiry.priority]}</Badge>
            {enquiry.assignedToName ? (
              <Badge tone="neutral">Assigned to {enquiry.assignedToName}</Badge>
            ) : (
              <Badge tone="muted">Unassigned</Badge>
            )}
          </div>
        </div>
      </div>

      {duplicates.length > 0 ? (
        <Card className="mt-4 border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <div className="text-sm font-medium text-ink">Possible duplicate enquiry</div>
          <ul className="mt-1.5 space-y-1 text-[13px] text-body">
            {duplicates.map((d) => (
              <li key={d.id}>
                <Link href={`/enquiries/list/${d.id}`} className="text-brand hover:text-brand-hover">
                  {shortDateWithYear(d.receivedAt, today())}
                </Link>
                {" · "}{d.source} · {STAGE_LABEL[d.stage]} · {d.assignedToName ?? "Unassigned"}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4">
        <div className="flex flex-col gap-4">
          <Card>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "overview", label: "Overview" },
                { key: "timeline", label: "Activity", count: enquiry.activity.length },
                { key: "followup", label: "Follow-ups", count: enquiry.remindersList.length },
                { key: "orders", label: "Orders", count: enquiry.linkedOrders.length },
              ]}
            />
            <div className="p-5">
              {tab === "overview" ? (
                <OverviewTab enquiry={enquiry} submission={submission} onAfter={after} />
              ) : null}
              {tab === "timeline" ? <TimelineTab enquiry={enquiry} /> : null}
              {tab === "followup" ? (
                <FollowUpTab enquiry={enquiry} team={team} onAfter={after} />
              ) : null}
              {tab === "orders" ? (
                <OrdersTab enquiry={enquiry} candidates={orderCandidates} onAfter={after} />
              ) : null}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <AssignmentCard enquiry={enquiry} team={team} onAfter={after} />
          <StageCard enquiry={enquiry} onAfter={after} />
          {!enquiry.customerId ? <CustomerMatchCard enquiry={enquiry} phone={displayPhone} onAfter={after} /> : (
            <Card className="p-5">
              <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Customer</div>
              <div className="mt-2 text-sm font-medium text-ink">{enquiry.customerName}</div>
              <div className="text-[13px] text-muted">{enquiry.customerCity}</div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function OverviewTab({
  enquiry,
  submission,
  onAfter,
}: {
  enquiry: EnquiryDetail;
  submission: EnquirySubmissionFields;
  onAfter: (p: Promise<Result>) => Promise<void>;
}) {
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const other = otherSubmissionFields(enquiry.rawSubmission);

  async function saveNote() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await onAfter(addNoteAction(enquiry.id, note));
      setNote("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Submission</div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Field label="Name"><div className="text-ink">{submission.name ?? "—"}</div></Field>
          <Field label="Phone"><div className="text-ink">{submission.phone ? phoneDisplay(submission.phone) : "—"}</div></Field>
          <Field label="Email"><div className="text-ink">{submission.email ?? "—"}</div></Field>
          <Field label="Company"><div className="text-ink">{submission.company ?? "—"}</div></Field>
        </dl>
        {submission.message ? (
          <div className="mt-3 rounded-[4px] border-l-[3px] border-l-brand bg-canvas px-3 py-2.5 text-[13px] text-ink italic">
            “{submission.message}”
          </div>
        ) : null}
        {other.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
            {other.map(([k, v]) => (
              <div key={k}>
                <span className="text-muted">{k}: </span>
                <span className="text-ink">{v}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Enquiry</div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Field label="Source"><div className="text-ink">{enquiry.source}</div></Field>
          <Field label="Source form"><div className="text-ink">{enquiry.sourceForm ?? "—"}</div></Field>
          <Field label="Received"><div className="text-ink">{stamp(enquiry.receivedAt)}</div></Field>
          <Field label="Reference"><div className="text-ink">{enquiry.externalRef ?? "—"}</div></Field>
        </dl>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Add a note</div>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="h-20 w-full" placeholder="Log what happened on this enquiry…" />
        <div className="mt-2 flex justify-end">
          <Button size="sm" disabled={busy || !note.trim()} onClick={saveNote}>Save note</Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ timeline */

function TimelineTab({ enquiry }: { enquiry: EnquiryDetail }) {
  if (enquiry.activity.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">Nothing recorded yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {enquiry.activity.map((a) => (
        <div key={a.id} className="relative border-l border-divider py-1 pl-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-ink">{ACTIVITY_LABEL[a.kind] ?? a.kind}</span>
            <span className="text-xs text-muted">{stamp(a.at)}</span>
          </div>
          {a.note ? <div className="mt-0.5 text-[13px] text-body">{a.note}</div> : null}
          <div className="mt-0.5 text-xs text-muted">{a.actorName ?? "System"}</div>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- followup */

function FollowUpTab({
  enquiry,
  team,
  onAfter,
}: {
  enquiry: EnquiryDetail;
  team: AssignableUser[];
  onAfter: (p: Promise<Result>) => Promise<void>;
}) {
  const [dueDate, setDueDate] = React.useState(today());
  const [note, setNote] = React.useState("");
  const [type, setType] = React.useState("call_back");
  const [assignee, setAssignee] = React.useState(enquiry.assignedToId ?? "");
  const [busy, setBusy] = React.useState(false);
  const canSchedule = !!enquiry.customerId;

  async function schedule() {
    if (!note.trim() || !assignee) return;
    setBusy(true);
    try {
      await onAfter(
        createEnquiryReminderAction({
          enquiryId: enquiry.id,
          dueDate,
          note,
          type: type as never,
          assignedUserId: assignee,
        }),
      );
      setNote("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {enquiry.remindersList.length > 0 ? (
        <div className="flex flex-col gap-2">
          {enquiry.remindersList.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-divider py-2 text-sm">
              <div>
                <div className="text-ink">{r.note}</div>
                <div className="text-xs text-muted">{r.type} · {r.assignedToName ?? "Unassigned"}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{shortDateWithYear(r.dueDate, today())}</span>
                <Badge tone={r.status === "completed" ? "success" : r.status === "dismissed" ? "muted" : "neutral"}>{r.status}</Badge>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No follow-ups scheduled yet.</p>
      )}

      <div className="border-t border-divider pt-4">
        {!canSchedule ? (
          <p className="text-[13px] text-muted">Link a customer to this enquiry before scheduling a follow-up.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
              <Field label="Type">
                <Select value={type} onChange={(e) => setType(e.target.value)} className="w-full">
                  <option value="call_back">Call back</option>
                  <option value="payment_promise">Payment promise</option>
                  <option value="order_confirmation">Order confirmation</option>
                  <option value="send_information">Send information</option>
                  <option value="check_stock">Check stock</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Assign to" className="col-span-2">
                <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-full">
                  <option value="">Choose somebody</option>
                  {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </Field>
              <Field label="Note" className="col-span-2">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="h-16 w-full" placeholder="What's this follow-up for?" />
              </Field>
            </div>
            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={busy || !note.trim() || !assignee} onClick={schedule}>Schedule follow-up</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- orders */

function OrdersTab({
  enquiry,
  candidates,
  onAfter,
}: {
  enquiry: EnquiryDetail;
  candidates: OrderCandidate[];
  onAfter: (p: Promise<Result>) => Promise<void>;
}) {
  const [picked, setPicked] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function link() {
    if (!picked) return;
    setBusy(true);
    try {
      await onAfter(linkOrderAction(enquiry.id, picked));
      setPicked("");
    } finally {
      setBusy(false);
    }
  }

  if (!enquiry.customerId) {
    return <p className="text-sm text-muted">Link a customer to this enquiry before linking an order.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {enquiry.linkedOrders.length > 0 ? (
        <div className="flex flex-col gap-2">
          {enquiry.linkedOrders.map((o) => (
            <div key={o.linkId} className="flex items-center justify-between border-b border-divider py-2 text-sm">
              <div>
                <div className="text-ink">{o.orderNo ?? o.orderId}</div>
                <div className="text-xs text-muted">{shortDateWithYear(o.orderedAt, today())} · {money(o.totalAmount)}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="neutral">{o.status}</Badge>
                <button
                  className="cursor-pointer text-xs text-danger hover:underline"
                  onClick={() => onAfter(unlinkOrderAction(enquiry.id, o.orderId))}
                >
                  Unlink
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No orders linked yet.</p>
      )}

      {candidates.length > 0 ? (
        <div className="border-t border-divider pt-4">
          <Field label="Link an existing order">
            <div className="flex gap-2">
              <Select value={picked} onChange={(e) => setPicked(e.target.value)} className="flex-1">
                <option value="">Choose an order</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.orderNo ?? c.id} · {shortDateWithYear(c.orderedAt, today())} · {money(c.totalAmount)}
                  </option>
                ))}
              </Select>
              <Button size="sm" disabled={busy || !picked} onClick={link}>Link</Button>
            </div>
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- side cards */

function AssignmentCard({
  enquiry,
  team,
  onAfter,
}: {
  enquiry: EnquiryDetail;
  team: AssignableUser[];
  onAfter: (p: Promise<Result>) => Promise<void>;
}) {
  return (
    <Card className="p-5">
      <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Assigned to</div>
      <Select
        className="mt-2 w-full"
        value={enquiry.assignedToId ?? ""}
        onChange={(e) => onAfter(assignEnquiryAction(enquiry.id, e.target.value || null))}
      >
        <option value="">Unassigned</option>
        {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
    </Card>
  );
}

function StageCard({
  enquiry,
  onAfter,
}: {
  enquiry: EnquiryDetail;
  onAfter: (p: Promise<Result>) => Promise<void>;
}) {
  return (
    <Card className="p-5">
      <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Stage</div>
      <Select
        className="mt-2 w-full"
        value={enquiry.stage}
        onChange={(e) => onAfter(changeStageAction(enquiry.id, e.target.value as EnquiryStage))}
      >
        {ENQUIRY_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
      </Select>

      <div className="mt-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Priority</div>
      <Select
        className="mt-2 w-full"
        value={enquiry.priority}
        onChange={(e) => onAfter(changePriorityAction(enquiry.id, e.target.value as EnquiryPriority))}
      >
        {ENQUIRY_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </Select>
    </Card>
  );
}

function CustomerMatchCard({
  enquiry,
  phone,
  onAfter,
}: {
  enquiry: EnquiryDetail;
  phone: string | null;
  onAfter: (p: Promise<Result>) => Promise<void>;
}) {
  const [matches, setMatches] = React.useState<CustomerMatch[] | null>(null);
  const [searching, setSearching] = React.useState(false);

  async function search() {
    if (!phone) return;
    setSearching(true);
    try {
      const r = await findCustomersByPhoneAction(phone);
      setMatches(r.ok ? r.data : []);
    } finally {
      setSearching(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Customer</div>
      <p className="mt-1.5 text-[13px] text-muted">Not linked to a customer yet.</p>

      {!phone ? (
        <p className="mt-2 text-[13px] text-muted">No phone number was submitted, so no match can be searched for.</p>
      ) : matches === null ? (
        <Button size="sm" className="mt-2" onClick={search} disabled={searching}>
          {searching ? "Searching…" : "Find matching customers"}
        </Button>
      ) : matches.length === 0 ? (
        <div className="mt-2 text-[13px] text-muted">No existing customer matches this phone number.</div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {matches.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-[4px] border border-line px-2.5 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink">{m.name}</div>
                <div className="text-xs text-muted">{phoneDisplay(m.phone)} · {m.city}</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => onAfter(linkCustomerAction(enquiry.id, m.id))}>
                Confirm
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
