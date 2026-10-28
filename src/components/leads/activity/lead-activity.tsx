"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Modal } from "@/components/ui/overlays";
import { Button as MenuButton } from "@/components/console/parts";
import { useToast } from "@/components/ui/toast";
import { Badge, Button, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { leadActivityHistoryAction, logLeadCall, logLeadVisit, visitSalesmenAction } from "@/lib/actions/lead-activity";
import {
  GENERAL_CALL_OUTCOMES,
  VISIT_OUTCOMES,
  type ActivityRow,
  type GeneralCallOutcome,
  type VisitOutcome,
} from "@/lib/lead-activity";
import { stamp, stampDate } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * CALL AND VISIT, the same way for a Telecaller and a Sales Manager.
 *
 * One dialog pair and one history, mounted by both desks' record screens and by
 * a row's quick actions on both dashboards. They decide nothing: the rules are
 * `actions/lead-activity.ts`, which checks the capability and the lead's scope
 * again — a dialog is not a permission.
 *
 * A GENERAL call is deliberately not the qualification call. The Calling Desk's
 * Call 1/2/3 keeps its own dialog, its own answers and its own cap; this panel
 * links to it where it applies and says plainly that the two are different, so
 * "I rang to say hello" is never mistaken for one of the three.
 * ------------------------------------------------------------------------- */

const FieldLabel = ({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) => (
  <label className={cx("block", className)}>
    <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
    <span className="block">{children}</span>
  </label>
);

/** One per opening of a dialog, so a double-click or a retry lands once. */
const newKey = () => crypto.randomUUID().replaceAll("-", "").slice(0, 24);

/* ---------------------------------------------------------------- the dialogs */

export function GeneralCallDialog({
  customerId,
  leadName,
  onClose,
  onSaved,
}: {
  customerId: string;
  leadName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [clientKey] = React.useState(newKey);
  const [outcome, setOutcome] = React.useState<GeneralCallOutcome>("spoke");
  const [notes, setNotes] = React.useState("");
  const [onDate, setOnDate] = React.useState("");
  const [atTime, setAtTime] = React.useState("");
  const [followUpDate, setFollowUpDate] = React.useState("");
  const [followUpText, setFollowUpText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    let r;
    try {
      r = await logLeadCall({
        customerId,
        clientKey,
        outcome,
        notes: notes.trim() || undefined,
        onDate: onDate || undefined,
        atTime: atTime || undefined,
        followUpDate: followUpDate || undefined,
        followUpText: followUpText.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!r.ok) {
      setError(r.error);
      return;
    }
    toast.push(r.message ?? "Call logged.");
    onSaved();
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <div>
          <div>Log a call</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{leadName}</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save call"}
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded-[4px] border border-line bg-canvas px-3 py-2 text-[12.5px] text-muted">
        This is an ordinary call. It does not count as one of the three qualification calls.
      </div>
      <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">How did it go?</div>
      <div className="mb-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {GENERAL_CALL_OUTCOMES.map((o) => (
          <label
            key={o.code}
            className={cx(
              "block cursor-pointer rounded-[4px] border px-3 py-2 text-[13px]",
              outcome === o.code ? "border-brand bg-brand-soft" : "border-line bg-surface hover:bg-canvas",
            )}
          >
            <input
              type="radio"
              name="call-outcome"
              className="mr-2"
              checked={outcome === o.code}
              onChange={() => setOutcome(o.code)}
            />
            <span className="font-medium text-ink">{o.label}</span>
            <span className="block pl-5 text-[12px] text-muted">{o.hint}</span>
          </label>
        ))}
      </div>
      <FieldLabel label="Notes" className="mb-3">
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
      </FieldLabel>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <FieldLabel label="Follow-up on (optional)">
          <Input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} className="w-full" />
        </FieldLabel>
        <FieldLabel label="Follow-up is">
          <Input
            value={followUpText}
            onChange={(e) => setFollowUpText(e.target.value)}
            placeholder="Call back"
            maxLength={300}
            className="w-full"
          />
        </FieldLabel>
      </div>
      <details className="mb-1">
        <summary className="cursor-pointer text-[12.5px] text-muted">▸ It happened earlier than now</summary>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <FieldLabel label="Date">
            <Input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} className="w-full" />
          </FieldLabel>
          <FieldLabel label="Time">
            <Input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} className="w-full" />
          </FieldLabel>
        </div>
      </details>
      {error ? <div className="mt-3 text-[13px] text-danger">{error}</div> : null}
    </Modal>
  );
}

export function ManualVisitDialog({
  customerId,
  leadName,
  onClose,
  onSaved,
}: {
  customerId: string;
  leadName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [clientKey] = React.useState(newKey);
  const [people, setPeople] = React.useState<{ id: string; name: string }[]>([]);
  const [salesmanId, setSalesmanId] = React.useState("");
  const [outcome, setOutcome] = React.useState<VisitOutcome>("visited");
  const [discussion, setDiscussion] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [onDate, setOnDate] = React.useState("");
  const [atTime, setAtTime] = React.useState("");
  const [followUpDate, setFollowUpDate] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    void visitSalesmenAction(customerId).then((r) => {
      if (!live || !r.ok) return;
      setPeople(r.data.people);
      setSalesmanId(r.data.meId);
    });
    return () => {
      live = false;
    };
  }, [customerId]);

  async function save() {
    setBusy(true);
    setError(null);
    let r;
    try {
      r = await logLeadVisit({
        customerId,
        clientKey,
        outcome,
        discussion: discussion.trim() || undefined,
        notes: notes.trim() || undefined,
        /* Sent only where it names somebody other than the person recording it. */
        salesmanId: salesmanId && salesmanId !== people[0]?.id ? salesmanId : undefined,
        onDate: onDate || undefined,
        atTime: atTime || undefined,
        followUpDate: followUpDate || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!r.ok) {
      setError(r.error);
      return;
    }
    toast.push(r.message ?? "Visit logged.");
    onSaved();
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <div>
          <div>Log a visit</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{leadName}</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save visit"}
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded-[4px] border border-line bg-canvas px-3 py-2 text-[12.5px] text-muted">
        A visit written in by hand. No location, check-in or duration is recorded.
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <FieldLabel label="Salesman who visited">
          <Select value={salesmanId} onChange={(e) => setSalesmanId(e.target.value)} className="w-full">
            {people.map((p, i) => (
              <option key={p.id} value={p.id}>
                {i === 0 ? `${p.name} (me)` : p.name}
              </option>
            ))}
          </Select>
        </FieldLabel>
        <FieldLabel label="What came of it">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as VisitOutcome)} className="w-full">
            {VISIT_OUTCOMES.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </Select>
        </FieldLabel>
      </div>
      <FieldLabel label="What was discussed" className="mb-3">
        <Textarea rows={2} value={discussion} onChange={(e) => setDiscussion(e.target.value)} maxLength={1000} />
      </FieldLabel>
      <FieldLabel label="Notes" className="mb-3">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
      </FieldLabel>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <FieldLabel label="Visit date (leave empty for now)">
          <Input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} className="w-full" />
        </FieldLabel>
        <FieldLabel label="Time">
          <Input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} className="w-full" />
        </FieldLabel>
      </div>
      <FieldLabel label="Follow-up on (optional)">
        <Input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} className="w-full" />
      </FieldLabel>
      {error ? <div className="mt-3 text-[13px] text-danger">{error}</div> : null}
    </Modal>
  );
}

export function HistoryDialog({
  customerId,
  leadName,
  onClose,
}: {
  customerId: string;
  leadName: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={
        <div>
          <div>Calls &amp; visits</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{leadName}</div>
        </div>
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <LeadActivityPanel customerId={customerId} leadName={leadName} canWork />
    </Modal>
  );
}

/* ----------------------------------------------------------------- the panel */

const KIND_BADGE: Record<ActivityRow["kind"], { label: string; tone: "brand" | "success" | "neutral" | "warn" }> = {
  qualification_call: { label: "Qualification call", tone: "brand" },
  general_call: { label: "Call", tone: "neutral" },
  call: { label: "Call", tone: "neutral" },
  visit: { label: "Visit", tone: "success" },
};

const SOURCE_TEXT: Record<ActivityRow["source"], string> = {
  desk: "Calling desk",
  handset: "Salesman App",
  web: "Logged by hand",
};

export function LeadActivityPanel({
  customerId,
  leadName,
  canWork,
  qualification,
}: {
  customerId: string;
  leadName: string;
  /** Whether this person may log against the lead. The server asks again. */
  canWork: boolean;
  /** The Calling Desk's own Call 1/2/3 entry point, where one applies. */
  qualification?: { label: string; onClick: () => void } | null;
}) {
  const [rows, setRows] = React.useState<ActivityRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [open, setOpen] = React.useState<"call" | "visit" | null>(null);

  React.useEffect(() => {
    let live = true;
    void leadActivityHistoryAction(customerId).then((r) => {
      if (!live) return;
      if (r.ok) {
        setRows(r.data);
        setError(null);
      } else {
        setError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [customerId, reload]);

  const why = canWork ? undefined : "You do not have permission to log activity on this lead.";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!canWork} title={why} onClick={() => setOpen("call")}>
          Log a call
        </Button>
        <Button variant="secondary" disabled={!canWork} title={why} onClick={() => setOpen("visit")}>
          Log a visit
        </Button>
        {qualification ? (
          <button
            type="button"
            onClick={qualification.onClick}
            className="cursor-pointer text-[13px] text-brand hover:text-brand-hover"
          >
            {qualification.label} →
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>
      ) : rows === null ? (
        <div className="py-6 text-center text-[13px] text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-[4px] border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">
          No calls or visits have been recorded on this lead yet.
        </div>
      ) : (
        <ol className="divide-y divide-divider rounded-[4px] border border-line bg-surface">
          {rows.map((a) => {
            const badge = KIND_BADGE[a.kind];
            return (
              <li key={a.key} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <span className="text-sm font-medium text-ink">{a.title}</span>
                  {a.outcome ? <span className="text-[13px] text-body">· {a.outcome}</span> : null}
                  <span className="ml-auto text-[12px] text-muted" title={a.at}>
                    {stamp(a.at)}
                  </span>
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted">
                  {a.byName ?? "Someone who has since left"} · {SOURCE_TEXT[a.source]}
                </div>
                {a.notes ? <div className="mt-1 text-[13px] whitespace-pre-wrap text-body">{a.notes}</div> : null}
                {a.followUpDate ? (
                  <div className="mt-1 text-[12.5px] text-body">
                    <span className="text-muted">Follow-up: </span>
                    {a.followUpText ? `${a.followUpText} · ` : ""}
                    {stampDate(a.followUpDate)}
                  </div>
                ) : null}
                {a.note ? <div className="mt-1 text-[12px] text-muted italic">{a.note}</div> : null}
              </li>
            );
          })}
        </ol>
      )}

      {open === "call" ? (
        <GeneralCallDialog
          customerId={customerId}
          leadName={leadName}
          onClose={() => setOpen(null)}
          onSaved={() => setReload((n) => n + 1)}
        />
      ) : null}
      {open === "visit" ? (
        <ManualVisitDialog
          customerId={customerId}
          leadName={leadName}
          onClose={() => setOpen(null)}
          onSaved={() => setReload((n) => n + 1)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------- inside the lead page's ··· menu */

/**
 * Log a call, Log a visit and Calls & visits, as three more items in the lead
 * page's EXISTING `···` menu — same button style as Reassign and Change sales
 * type beside them, no new card and no new tab. Call and Visit are enabled only
 * where the person may work the lead; the server checks again on every write.
 */
export function ActivityMenuItems({
  customerId,
  leadName,
  canWork,
}: {
  customerId: string;
  leadName: string;
  canWork: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<"call" | "visit" | "history" | null>(null);
  const why = canWork ? undefined : "Working a lead is the salesman's and the manager's.";
  return (
    <>
      <MenuButton size="sm" tone="quiet" disabled={!canWork} title={why ?? "Log a call you made to this lead."} onClick={() => setOpen("call")}>
        Log a call
      </MenuButton>
      <MenuButton size="sm" tone="quiet" disabled={!canWork} title={why ?? "Log a visit to this lead."} onClick={() => setOpen("visit")}>
        Log a visit
      </MenuButton>
      <MenuButton size="sm" tone="quiet" title="Every call and visit on this lead, in one list." onClick={() => setOpen("history")}>
        Calls &amp; visits
      </MenuButton>
      {open === "call" ? <GeneralCallDialog customerId={customerId} leadName={leadName} onClose={() => setOpen(null)} onSaved={() => router.refresh()} /> : null}
      {open === "visit" ? <ManualVisitDialog customerId={customerId} leadName={leadName} onClose={() => setOpen(null)} onSaved={() => router.refresh()} /> : null}
      {open === "history" ? <HistoryDialog customerId={customerId} leadName={leadName} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/* ------------------------------------------ inside the EXISTING Calls and visits card */

/**
 * Log a call, Log a visit and Calls & visits — the three buttons for the action
 * slot of the lead page's existing "Calls and visits" card. Nothing new is drawn
 * around them. Call and Visit are enabled only where the person may work the
 * lead; the server checks again on every write. A call logged here is an ordinary
 * call and never one of the three qualification calls, which keep their own
 * button and dialog at the head of the page.
 */
export function CallsVisitsCardActions({
  customerId,
  leadName,
  canWork,
}: {
  customerId: string;
  leadName: string;
  canWork: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<"call" | "visit" | "history" | null>(null);
  const why = canWork ? undefined : "Working a lead is the salesman's and the manager's.";
  return (
    <>
      <span className="flex flex-wrap items-center gap-1.5">
        <MenuButton size="sm" tone="quiet" disabled={!canWork} title={why ?? "Log a call you made to this lead."} onClick={() => setOpen("call")}>
          Log a call
        </MenuButton>
        <MenuButton size="sm" tone="quiet" disabled={!canWork} title={why ?? "Log a salesman's visit to this lead."} onClick={() => setOpen("visit")}>
          Log a visit
        </MenuButton>
        <MenuButton size="sm" tone="quiet" title="Every call and visit on this lead, in one list." onClick={() => setOpen("history")}>
          Calls &amp; visits
        </MenuButton>
      </span>
      {open === "call" ? <GeneralCallDialog customerId={customerId} leadName={leadName} onClose={() => setOpen(null)} onSaved={() => router.refresh()} /> : null}
      {open === "visit" ? <ManualVisitDialog customerId={customerId} leadName={leadName} onClose={() => setOpen(null)} onSaved={() => router.refresh()} /> : null}
      {open === "history" ? <HistoryDialog customerId={customerId} leadName={leadName} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
