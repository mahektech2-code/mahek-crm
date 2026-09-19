"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { assignLeadManager } from "@/lib/actions/leads";

/** Who covers this lead's region, as `leadManagerCandidatesFor` answered it. */
export type LeadManagerCandidate = { id: string; name: string; national: boolean };

/**
 * §7 — WHO OWES THE VERIFICATION CALL, and the door `assignLeadManager` never
 * had.
 *
 * The seat is read by `scopedToUsers` and by `assertCustomerInScope`, it is
 * what §13's nurture tasks are raised against, and it is the first thing owed
 * on a lead that reaches Prospect. The action was written, audited, notified
 * and tested, and nothing imported it — so the column filled in exactly one
 * way, as a side effect of `qualifyLead` reading the org chart, and could never
 * be corrected afterwards. A lead whose region moved, or whose qualification
 * seated the wrong person, sat with its verification call owed by somebody who
 * was not going to make it, and the only visible symptom was a lead going
 * quiet.
 *
 * **THE DEFAULT IS THE ACTION'S OWN DEFAULT, not a second reading of it.** The
 * list comes from `leadManagerCandidatesFor`, which is `leadManagerCandidates`
 * asked about this lead's region — the same function `assignLeadManager` calls
 * when nobody names anybody, sorted the same way, so the person at the head of
 * this picker is precisely who the action would have chosen. A screen working
 * out "who covers Vidarbha" for itself is the copy that drifts the day somebody
 * changes what an empty territory means.
 *
 * **AND WHOEVER COVERS NO REGION IS STILL OFFERED, marked.** No rows in
 * `mbos_user_territories` means national — the rule that table already carries
 * — so a manager with none of them is a legitimate answer and not a stray. The
 * word is on the row rather than implied by the ordering, because a list read
 * top-down teaches nobody why the second name is second.
 *
 * **NOBODY AT ALL IS A SENTENCE RATHER THAN AN EMPTY SELECT.** A picker with no
 * options is a screen somebody stares at; the honest answer is that no manager
 * covers this lead's region and there is no national one to fall back on, which
 * is a console problem and is what the action says in words too.
 *
 * **IT SAYS THAT ASSIGNING IS A DECISION, because the action stamps one.**
 * `lead_manager_decided_at` is the mark this codebase already puts on
 * `orders.approvedAt`, `bills.paymentDecidedAt` and `customers.amDecidedAt`:
 * it exists so a later automatic pass does not write over a person's answer.
 * `qualifyLead` deliberately does NOT set it — nobody decided that seat, the
 * org chart did — and this action does, so naming somebody here is the act that
 * freezes the seat against the org chart. That is a real consequence and it is
 * said on the screen before the button rather than discovered when a
 * reorganisation leaves one lead behind.
 *
 * `lead.work` and not a manager's, which is the action's own call: this seat
 * drives a WORKLIST and nothing else — no money moves, no book changes hands,
 * no target counts differently — so holding it back would mean a salesman
 * reaching Prospect on a Saturday waits until Monday for somebody to press a
 * button. The capability is checked in the action as well; a disabled button is
 * a fact about a component.
 */
export function AssignLeadManager({
  customerId,
  name,
  currentId,
  currentName,
  candidates,
  canWork,
}: {
  customerId: string;
  name: string;
  /** The seat as it stands, so the picker can mark who is already in it. */
  currentId: string | null;
  currentName: string | null;
  /** Region first, national below — the action's own order, left alone. */
  candidates: LeadManagerCandidate[];
  canWork: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* The head of the list, which is who the action picks when nothing is named.
     Marked as such in the picker rather than merely pre-selected: "the default"
     is information about how this lead would be seated if nobody chose, and a
     silently ticked radio says nothing. */
  const suggested = candidates[0] ?? null;

  function begin() {
    /* Pre-selected to the seat as it stands where there is one, and to the
       computed default where there is not — so the commonest act, agreeing
       with the default on an unseated lead, is one button rather than two. */
    setChosen(currentId ?? suggested?.id ?? "");
    setError(null);
    setOpen(true);
  }

  async function submit() {
    if (!chosen) {
      setError("Name who is to hold this lead.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await assignLeadManager(customerId, chosen);
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Lead manager set.");
    router.refresh();
  }

  return (
    <>
      <Button
        size="sm"
        tone="quiet"
        disabled={!canWork}
        title={
          canWork
            ? "Who owes the verification call and the nurture tasks on this lead."
            : "Working a lead is not one of the hats you hold."
        }
        onClick={begin}
      >
        {currentId ? "Change who holds it" : "Assign a lead manager"}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={currentId ? "Change the lead manager" : "Assign a lead manager"}
        width={540}
      >
        <p className="mb-3 text-[13px] text-body">
          {name} · <span className="font-medium text-ink">{currentName ?? "Nobody holds it"}</span>
        </p>
        <p className="mb-3 text-[13px] text-pretty text-body">
          The lead manager owes the verification call, the §13 nurture tasks and the chasing behind
          them. They are told as soon as you save this. It moves no revenue and no target — whose
          book this account is in is a different seat, changed on the customer record.
        </p>

        {candidates.length === 0 ? (
          <p className="text-[13px] text-pretty text-warn-ink">
            Nobody covers this lead&rsquo;s region and there is no national sales manager to fall
            back on. Set a territory in the Admin Console, or give somebody the manager level, and
            this list fills itself.
          </p>
        ) : (
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 block text-[13px] font-medium text-ink">
              Who is to hold it
            </legend>
            <div className="flex flex-col gap-2">
              {candidates.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-start gap-2 rounded-[4px] border border-line px-2.5 py-2"
                >
                  <input
                    type="radio"
                    name="lead-manager"
                    value={c.id}
                    checked={chosen === c.id}
                    onChange={() => setChosen(c.id)}
                    className="mt-1"
                  />
                  <span className="block min-w-0">
                    <span className="block text-[13px] font-medium text-ink">
                      {c.name}
                      {c.id === currentId ? " — holds it now" : ""}
                    </span>
                    <span className="block text-[12px] text-pretty text-muted">
                      {c.national
                        ? "Covers everywhere — no territory rows, which this product reads as national."
                        : "Covers this lead's region."}
                      {suggested && c.id === suggested.id && c.id !== currentId
                        ? " This is who the office would seat if nobody chose."
                        : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {/* The mark, said before the button. It is the same kind of mark as an
            order's approval and a bill's payment decision: what it buys is that
            no later automatic pass writes over it. */}
        <p className="mt-3 text-[12px] text-pretty text-muted">
          Naming somebody here is recorded as a person&rsquo;s decision, so a later org-chart pass
          will leave this seat alone rather than reseating it. Qualifying a lead does not make that
          mark — the org chart fills the seat then, and nobody has chosen.
        </p>

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || !chosen || candidates.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Save the seat"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
