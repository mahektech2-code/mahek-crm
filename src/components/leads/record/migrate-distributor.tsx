"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { salesTypeLabel, stageLabel, type LeadStage } from "@/lib/lead-labels";
import { ladderFor, isTerminal } from "@/lib/engines/lead-ladder";
import { migrateProspectiveDistributor } from "@/lib/actions/lead-distributor-migration";
import { Button } from "@/components/console/parts";

/**
 * THE DOOR ONTO `migrateProspectiveDistributor`, which had none.
 *
 * The action was finished — audited, transactional, with the whole of Mahek's
 * reasoning in its own header — and nothing imported it. This codebase treats
 * that as a defect in its own right rather than as an unfinished screen: a
 * function with no caller is legal TypeScript and clean lint, so nothing goes
 * red, and the feature simply does not exist for anybody who cannot run SQL.
 * The worklist under Distributor appointments is the other half of the same
 * fix — this is how ONE lead is moved, and that is how somebody finds out
 * which.
 *
 * **WHO IS OFFERED IT is decided by the caller, and it is four questions.**
 * The lead has to be on the distributor ladder, it must not be standing on
 * `active_distributor`, it must not be closed, and the viewer has to hold
 * `lead.override`. Every one of those is refused by the action too — a server
 * action is a URL and a hidden button is not a permission — and drawn here
 * because a control that is offered and then refuses is one people press twice.
 *
 * **`lead.override` and NOT the `canOverride` prop beside it.** That one is the
 * capability AND `leads.allowManagerOverride`, which is the switch a team
 * throws when it would rather leads got stuck than got pushed past a shut gate.
 * This passes no gate: it moves a lead off a ladder that was retired underneath
 * it, which is a clerical correction Mahek asked for rather than a rule being
 * bent, and the action deliberately does not read that setting. Reading it here
 * would make a team that turned overrides off unable to clear a backlog nobody
 * chose to have.
 *
 * **Three answers, and the form demands all three** — because the action does,
 * and a form that let two of them through would produce a refusal that reads as
 * the app being broken rather than as a question not yet answered.
 */
export function MigrateDistributor({
  customerId,
  name,
  stage,
  canMigrate,
}: {
  customerId: string;
  name: string;
  /** The rung it stopped on, so the modal can say what is being left behind. */
  stage: LeadStage;
  canMigrate: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  /*
   * NOTHING IS PRE-SELECTED HERE, the same rule `MarkLost` follows one control
   * along and for the same reason: whether we invoice this shop or a
   * distributor does is not derivable from anything on the row — the old
   * ladder never asked, because on it the answer was going to be "we invoice
   * them" once the appointment went through. A default would answer it, at
   * scale, in whichever direction happened to sit first.
   */
  const [to, setTo] = React.useState<"" | "direct" | "third_party">("");
  /*
   * WHERE IT LANDS defaults to `qualification` and the rest of the ladder is
   * offered. See the action's own header for why that rung: it is the last one
   * all three ladders share, so it is the highest point a lead can be put down
   * on without asserting something nobody established. Everything above it on
   * the old ladder was about appointing a distributor — a management review, a
   * commercial discussion, a stock commitment — and none of that is evidence
   * that this shop has had a sample, agreed a price or promised an order,
   * which is what the rungs above qualification mean on the new one.
   */
  const [stageWanted, setStageWanted] = React.useState<LeadStage>("qualification");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /*
   * The rungs on offer are the NEW ladder's, minus its terminals: migrating a
   * lead is putting it back to work, and landing it on `customer` or `won`
   * would be closing it under another name. The action refuses those too.
   */
  const options = to
    ? ladderFor(to).filter((s) => !isTerminal(s))
    : ([] as readonly LeadStage[]);

  /*
   * DERIVED, never reset in an effect. The two ladders are not the same list —
   * `sample_received` is on the direct one and not the third-party one — so
   * picking a rung and then changing the kind of sale can leave a choice that
   * no longer exists. The React Compiler rules forbid correcting that from an
   * effect, and there is no need to: the rung that actually gets sent is
   * computed here, and falls back to the default the screen already argues for.
   */
  const chosen: LeadStage = options.includes(stageWanted) ? stageWanted : "qualification";

  function begin() {
    setTo("");
    setStageWanted("qualification");
    setReason("");
    setError(null);
    setOpen(true);
  }

  async function submit() {
    /* Refused here as well as by the disabled button, so somebody who reached
       it by keyboard is told what is wanted rather than nothing happening. */
    if (!to) {
      setError("Say which kind of sale this is now. Nothing on the record answers it.");
      return;
    }
    if (!reason.trim()) {
      setError("Say why, and what it is now. The reason is what tells the next reader that the ladder moved rather than the lead.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await migrateProspectiveDistributor({
        customerId,
        to,
        stage: chosen,
        reason: reason.trim(),
      });
    } finally {
      /* Cleared whatever happened: an action that rejects rather than
         returning a Result would otherwise leave the button dead until a
         reload. */
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? `${name} has been moved.`);
    router.refresh();
  }

  return (
    <>
      <Button
        tone="strong"
        size="sm"
        disabled={!canMigrate}
        title={
          canMigrate
            ? "Move this lead off the retired distributor ladder onto the one it is actually sold on."
            : "Moving a lead across ladders is a manager's — it puts it down on a rung its own gates did not open."
        }
        onClick={begin}
      >
        Move off the distributor ladder
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Move off the distributor ladder"
        width={560}
      >
        <p className="mb-3 text-[13px] text-body">
          {name} is a <strong>{salesTypeLabel("distributor")}</strong> at{" "}
          <strong>{stageLabel(stage)}</strong>. Mahek appoints distributors outside MahekOne, so
          that ladder ends at an approval nobody here can give. Moving it keeps everything: the old
          ladder and the rung it reached stay on its transitions for ever, recorded as a further
          move rather than as an edit.
        </p>

        <div className="mb-1 text-[13px] font-medium text-ink">
          What kind of sale is this now · required
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="flex cursor-pointer items-start gap-2 rounded-[4px] px-1.5 py-1 text-[13px] text-body hover:bg-canvas">
            <input
              type="radio"
              name="migrate-to"
              className="mt-[3px]"
              checked={to === "direct"}
              onChange={() => setTo("direct")}
            />
            <span>
              {salesTypeLabel("direct")}
              <span className="block text-[12px] text-muted">
                We invoice this account ourselves.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-[4px] px-1.5 py-1 text-[13px] text-body hover:bg-canvas">
            <input
              type="radio"
              name="migrate-to"
              className="mt-[3px]"
              checked={to === "third_party"}
              onChange={() => setTo("third_party")}
            />
            <span>
              {salesTypeLabel("third_party")}
              <span className="block text-[12px] text-muted">
                A distributor invoices them and we support the shop.
              </span>
            </span>
          </label>
        </div>
        <p className="mt-1.5 text-[12px] text-muted">
          Ask which of the two is actually happening — nothing on this record answers it, because
          the old ladder never had to ask.
        </p>

        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Where it lands</span>
          <select
            value={chosen}
            disabled={!to}
            onChange={(e) => setStageWanted(e.target.value as LeadStage)}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand disabled:text-muted"
          >
            {to ? (
              options.map((s) => (
                <option key={s} value={s}>
                  {stageLabel(s)}
                </option>
              ))
            ) : (
              <option value="qualification">{stageLabel("qualification")}</option>
            )}
          </select>
        </label>
        <p className="mt-1.5 text-[12px] text-muted">
          Qualification by default, because it is the last rung all three ladders share — and
          everything above it on the old one was about appointing a distributor, which is not
          evidence that this shop has had a sample or agreed a price. Put it higher where there is
          a real order or documented commercial progress behind it.
        </p>

        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Why · required</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="What this account actually is, and what the rung is based on."
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || !to || !reason.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Moving…" : "Move it"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
