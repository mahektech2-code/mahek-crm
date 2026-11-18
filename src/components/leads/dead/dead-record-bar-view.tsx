"use client";

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import { labelOf } from "@/lib/lead-labels";
import { DEAD_REASONS } from "@/lib/lead-dead";
import { DEAD_REQUEST_STATE_LABEL, type DeadRequestState } from "@/lib/lead-dead";
import { MarkDeadDialog } from "./mark-dead-dialog";
import { WithdrawButton } from "./withdraw-button";
import { DecideDeadDialog, type DecidableRequest } from "./decide-dead-dialog";

type HistoryRow = {
  id: string;
  state: DeadRequestState;
  requestedByName: string | null;
  requestedAt: string;
  approverName: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  reasonCode: string;
  note: string | null;
  decisionNote: string | null;
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");

export function DeadRecordBarView({
  lead,
  dead,
  lost,
  canWork,
  pending,
  approvedAt,
  approvedByName,
  history,
}: {
  lead: { id: string; name: string };
  dead: boolean;
  lost: boolean;
  canWork: boolean;
  pending: (DecidableRequest & { approverName: string | null; requestedAt: string; mine: boolean; askedByMe: boolean }) | null;
  approvedAt: string | null;
  approvedByName: string | null;
  history: HistoryRow[];
}) {
  const [marking, setMarking] = React.useState(false);
  const [deciding, setDeciding] = React.useState(false);

  return (
    <div className="mx-6 mt-4">
      {dead ? (
        <div className="rounded-[6px] border border-danger bg-danger-soft px-4 py-3 text-[14px] text-body">
          <b className="text-danger">Permanently Dead — read-only.</b> Approved by {approvedByName ?? "the reporting manager"} on{" "}
          {day(approvedAt)}. This lead can be viewed, with its calls, visits, orders and history, but nothing on it can be
          changed, reassigned, reopened, converted or added to.
        </div>
      ) : pending ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[6px] border border-warn bg-warn-soft px-4 py-3 text-[14px] text-body">
          <span className="min-w-0 flex-1">
            <b>Dead request pending.</b> {pending.requestedByName ?? "Somebody"} asked on {day(pending.requestedAt)};{" "}
            {pending.mine ? "it is waiting on you." : `waiting on ${pending.approverName ?? "the reporting manager"}.`} The lead stays
            Lost and cannot be reversed until it is decided.
          </span>
          {pending.mine ? <Button onClick={() => setDeciding(true)}>Review request</Button> : null}
          {pending.askedByMe ? <WithdrawButton requestId={pending.id} /> : null}
        </div>
      ) : lost ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[6px] border border-line bg-surface px-4 py-3 text-[14px] text-body">
          <span className="min-w-0 flex-1">
            This lead is Lost. If it will never be worked again it can be marked <b>Dead</b> — permanent, and only after your
            reporting manager approves.
          </span>
          <Button
            variant="secondary"
            disabled={!canWork}
            title={canWork ? undefined : "Asking for a lead to be marked Dead needs the lead.work access, which yours does not carry."}
            onClick={() => setMarking(true)}
          >
            Mark as Dead
          </Button>
        </div>
      ) : null}

      {history.length ? (
        <details className="mt-2 rounded-[6px] border border-line bg-surface px-4 py-2 text-[13px]">
          <summary className="cursor-pointer text-muted">Dead request history ({history.length})</summary>
          <ul className="m-0 mt-2 list-none p-0">
            {history.map((r) => (
              <li key={r.id} className="border-t border-line py-2 first:border-t-0">
                <b>{DEAD_REQUEST_STATE_LABEL[r.state]}</b> · asked by {r.requestedByName ?? "—"} on {day(r.requestedAt)} ·{" "}
                {labelOf(DEAD_REASONS, r.reasonCode)}
                {r.note ? ` — ${r.note}` : ""}
                {r.state !== "pending" ? (
                  <span className="block text-muted">
                    {r.state === "approved" ? "Approved" : "Rejected"} by {r.decidedByName ?? r.approverName ?? "—"} on {day(r.decidedAt)}
                    {r.decisionNote ? ` — ${r.decisionNote}` : ""}
                  </span>
                ) : (
                  <span className="block text-muted">Waiting on {r.approverName ?? "—"}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {marking ? <MarkDeadDialog lead={lead} onClose={() => setMarking(false)} /> : null}
      {deciding && pending ? <DecideDeadDialog request={pending} onClose={() => setDeciding(false)} /> : null}
    </div>
  );
}
