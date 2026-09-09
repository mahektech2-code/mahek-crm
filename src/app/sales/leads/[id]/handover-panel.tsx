"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import { isOnTheBookAt, promotesToCustomerAt } from "@/lib/engines/lead-ladder";
import { stageLabel, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";
import type { HandoverCandidate } from "@/lib/services/lead-console-service";
import { handOverToRelationshipOwner } from "@/lib/actions/leads";
import { Button, Pill } from "../../parts";

/**
 * §22 — the handover, when a lead stops being one.
 *
 * The lead manager works a LEAD: the verification call, the nurture sequence,
 * the files. A customer is worked by whoever owns the account, and that is a
 * different job with a different worklist — which is why `lead_manager_id` is
 * released on promotion rather than quietly becoming a permanent second seat.
 *
 * **The screen names the person and says both were told.** A book that grows
 * overnight reads as a bug in the queue, and one that shrinks reads as the same
 * bug from the other end; the notification is the whole difference between a
 * handover and an account silently changing hands. So the sentence is on the
 * screen rather than only in the action — somebody handing over needs to know
 * it happened without going to look.
 *
 * **`kind` flips at the FIRST order, and the ladder carries on.** MahekOne's
 * own word for a customer is an account that has ordered, and thirty places
 * read it that way; §22 says Customer at the second. The two words are
 * separated rather than reconciled, and this panel says which one it is talking
 * about so nobody reads the badge as a contradiction.
 */
export function HandoverPanel({
  customerId,
  leadName,
  stage,
  salesType,
  convertedAt,
  leadManagerName,
  currentOwnerId,
  currentOwnerName,
  candidates,
  canWork,
  canReassign,
}: {
  customerId: string;
  leadName: string;
  stage: LeadStage;
  salesType: LeadSalesType | null;
  convertedAt: Date | null;
  leadManagerName: string | null;
  currentOwnerId: string | null;
  currentOwnerName: string | null;
  candidates: HandoverCandidate[];
  canWork: boolean;
  canReassign: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [ownerId, setOwnerId] = React.useState(currentOwnerId ?? "");
  const [search, setSearch] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const promotesAt = promotesToCustomerAt(salesType);
  const onTheBook = isOnTheBookAt(stage, salesType);

  const shown = candidates.filter((c) =>
    search.trim() ? c.name.toLowerCase().includes(search.trim().toLowerCase()) : true,
  );

  return (
    <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Handover
          </div>
          <p className="mt-1 max-w-[520px] text-[12px] text-pretty text-muted">
            When a lead becomes an account somebody has to own the relationship. The lead manager
            is released — working a lead and working a customer are different jobs.
          </p>
        </div>
        <Button
          size="sm"
          disabled={!canWork || !onTheBook}
          title={
            !canWork
              ? "Working a lead is the salesman's and the manager's."
              : !onTheBook
                ? `Not yet — this account goes on the book at ${stageLabel(promotesAt)}.`
                : undefined
          }
          onClick={() => setOpen(true)}
        >
          Name the owner
        </Button>
      </div>

      <div className="mt-2 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          {onTheBook ? (
            <Pill tone="success">On the book</Pill>
          ) : (
            <Pill tone="neutral">Still a lead</Pill>
          )}
          {convertedAt ? (
            <span className="text-[12px] text-muted">converted {stamp(convertedAt)}</span>
          ) : null}
        </div>
        <div className="mt-1.5 text-body">
          Relationship owner: {currentOwnerName ?? <span className="text-warn-ink">nobody</span>}
        </div>
        <div className="text-muted">
          Lead manager: {leadManagerName ?? "nobody"}
          {onTheBook && leadManagerName
            ? " — still held. Naming an owner is what releases it."
            : ""}
        </div>
        {!onTheBook ? (
          <p className="mt-1.5 text-[12px] text-muted">
            The account goes on the book at {stageLabel(promotesAt)}. Until then the salesman and
            the lead manager are the two people working it, which is the arrangement the funnel is
            for.
          </p>
        ) : null}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Name the relationship owner" width={480}>
        <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
          <div className="font-medium text-ink">{leadName}</div>
          <div className="text-muted">
            Held by {currentOwnerName ?? "nobody"} · lead manager {leadManagerName ?? "nobody"}
          </div>
          <div className="mt-1 text-[12px] text-muted">Account {customerId}</div>
        </div>

        {/* One searchable list, always. A dropdown beats a search box while the
            list is short and loses the moment it is not, and building both
            means somebody has to notice on the day the eleventh person is
            hired. */}
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Hand it to</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people"
            className="mb-1.5 h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
          />
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            size={Math.min(8, Math.max(3, shown.length))}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-1 text-sm text-ink outline-none focus:border-brand"
          >
            {shown.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.role}
              </option>
            ))}
          </select>
        </label>

        <p className="mt-3 text-[13px] text-body">
          Both people are told — the person taking it, because work has moved onto their queue
          without them asking, and the person losing it, because a book that shrinks silently reads
          as a bug in the queue.
        </p>

        <p className="mt-2 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[12px] text-muted">
          Changing who owns an account is <strong className="font-medium text-body">accounts&rsquo;
          and admin&rsquo;s</strong>, not a manager&rsquo;s — whose book an account is in decides
          whose targets it counts toward, and a manager moving accounts is a manager moving numbers
          between their own people. Ask accounts to make the change on the customer record; this
          screen names who it should be.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            tone="primary"
            disabled={!canReassign || !ownerId || busy}
            title={
              !canReassign
                ? "Moving an account is accounts' and admin's. Whose book it sits in decides whose targets it counts toward, so a manager cannot move numbers between their own people."
                : !ownerId
                  ? "Pick who takes the account on."
                  : undefined
            }
            onClick={() => {
              if (!ownerId || busy) return;
              setBusy(true);
              void handOverToRelationshipOwner({ customerId, ownerId }).then((r) => {
                setBusy(false);
                if (!r.ok) {
                  toast.push(r.error);
                  return;
                }
                toast.push(r.message ?? "Handed over.");
                setOpen(false);
                router.refresh();
              });
            }}
          >
            {busy ? "Handing over…" : "Hand it over"}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
