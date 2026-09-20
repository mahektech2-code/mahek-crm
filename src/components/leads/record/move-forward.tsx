"use client";

import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { Pill } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { GateVerdict } from "@/lib/engines/lead-gates";
import {
  gateAction,
  type LeadGateActionFacts,
  type LeadGateControl,
} from "@/lib/engines/lead-gate-action";
import { AdvanceStage } from "./advance-stage";

/* ---------------------------------------------------------------------------
 * §8.5 — "MOVE THIS LEAD FORWARD", and it is one card because it is one
 * question.
 *
 * What do I do next on THIS lead. The record could already answer three
 * quarters of it: the rail says which rung is next and what that rung is
 * waiting on, and the tabs hold every form. What it could not do is say which
 * form — the only button was spelled "Advance", on every rung of all four
 * ladders, so a manager on a Qualification lead with all eight conditions met
 * read a verb that told him less than the rung above it already had.
 *
 * TWO ENGINES AND NEITHER IS SECOND-GUESSED. `gateAction` says what this
 * rung's work IS; `gateForNext` says whether it has been done. This card is
 * built so it cannot offer an action the gate would refuse: where the verdict
 * is shut, the same verb is drawn DISABLED with the engine's own missing list
 * underneath it, exactly the refusal `AdvanceStage` and the rail already
 * produce. Where it is open, the verb becomes the control that asks the
 * question.
 *
 * AND IT DOES NOT REPLACE `AdvanceStage`. For every rung whose work is simply
 * a move — §5.6 through §5.9, §6.4, §6.6, §6.7 and §5.1's conversion — this
 * card renders that component unchanged: two buttons rather than one with a
 * mode, the override printing every missing condition rather than a count, and
 * the server re-checking `lead.work` and `lead.override` whatever the screen
 * drew. A card that reimplemented the move to put a better word on it would be
 * a second write path, and the unaudited door always wins in the end.
 * ------------------------------------------------------------------------- */

/**
 * WHERE EACH CONTROL ACTUALLY LIVES, which is the screen's half of the answer.
 *
 * The engine names what a person is being sent to DO and deliberately not
 * where — an href is workspace-relative and a modal is a component, so both
 * belong here. Three of these are not on this page at all: a sample is
 * dispatched and reviewed at the desk that holds the stock, and saying so is
 * the point. A card that offered only what this page happens to render would
 * go quiet on exactly the rungs where somebody most needs directions.
 *
 * Keyed on the union so a ninth control cannot be added without being placed.
 */
function destinationFor(
  control: Exclude<LeadGateControl, "advance" | "none">,
  workspace: LeadWorkspace,
  base: string,
): { href: string; where: string } {
  switch (control) {
    case "verify":
      return { href: `${base}/verify`, where: "the verification call" };
    case "request_sample":
      return { href: `${base}?tab=samples`, where: "the Samples tab" };
    case "sample_desk":
      return { href: leadHref(workspace, "samples/desk"), where: "the sample desk" };
    case "record_commitment":
    case "confirm_order":
      return { href: `${base}?tab=commercial`, where: "the Commercial tab" };
    case "management_approval":
      return { href: `${base}?tab=approval`, where: "the approval chain" };
  }
}

/** The three live tones as a link, and muted as no link at all. */
const LINK_SKIN: Record<"brand" | "warn" | "danger", string> = {
  brand: "border-brand bg-brand text-white hover:bg-brand-hover",
  warn: "border-warn bg-warn-soft text-warn-ink hover:bg-warn-soft",
  danger: "border-danger bg-danger-soft text-danger hover:bg-danger-soft",
};

export function MoveForward({
  workspace,
  base,
  customerId,
  facts,
  verdict,
  nextRung,
  canWork,
  canOverride,
  overrideAllowed,
}: {
  workspace: LeadWorkspace;
  /** Where this lead lives, so a verb can reach the thing that carries it. */
  base: string;
  customerId: string;
  facts: LeadGateActionFacts;
  /** `gateForNext`'s, computed on the server. This draws it and decides none of it. */
  verdict: GateVerdict;
  nextRung: LeadStage | null;
  canWork: boolean;
  canOverride: boolean;
  overrideAllowed: boolean;
}) {
  const action = gateAction(facts);

  /*
   * NOTHING TO PRESS IS AN ANSWER AND IS DRAWN AS ONE. A terminal rung, a lost
   * lead and a parked one each get their own sentence out of the engine,
   * because they send somebody to three different places — and a disabled
   * button that could never be enabled would be worse than none, which is the
   * rule the rail already follows one panel along.
   */
  if (action.control === "none") {
    return (
      <section className="rounded-[6px] border border-line bg-surface p-4">
        <h2 className="m-0 text-[13px] font-semibold tracking-[0.02em] text-muted uppercase">
          Move this lead forward
        </h2>
        <p className="mt-1.5 mb-0 text-[13px] text-pretty text-body">{action.says}</p>
      </section>
    );
  }

  const shut = !verdict.open && !verdict.noNextRung;

  return (
    <section className="rounded-[6px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-[13px] font-semibold tracking-[0.02em] text-muted uppercase">
          Move this lead forward
        </h2>
        {/* The rung this act lands on, said in the ladder's own words. The verb
            is what to do and the rung is where it gets you, and a card that
            named only one of them would send somebody to the rail to find the
            other. */}
        {nextRung ? (
          <span className="text-[12px] text-muted">
            {stageLabel(facts.stage)} → {stageLabel(nextRung)}
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {action.control === "advance" ? (
          /* §5's verb on the rung, and the SAME control underneath it. The
             component draws its own two buttons and its own override path; it
             is handed the same verdict the rail is, so the two cannot disagree
             about whether this lead may move. */
          <>
            <span className="text-[15px] font-medium text-ink">{action.label}</span>
            <AdvanceStage
              customerId={customerId}
              to={nextRung}
              verdict={verdict}
              canWork={canWork}
              canOverride={canOverride}
              overrideAllowed={overrideAllowed}
            />
          </>
        ) : shut ? (
          /*
           * THE VERB, DISABLED, AND WHAT IT IS WAITING ON. Not hidden: a card
           * that went blank on a shut gate would say the lead has nothing
           * waiting, which is the opposite of the truth. §28's argument is
           * that a refusal which does not say what it wants teaches somebody
           * to press the button again; the list underneath is the answer, and
           * it is the engine's own rather than a sentence typed here.
           */
          <span
            className="inline-flex h-9 cursor-not-allowed items-center rounded-[4px] border border-line bg-surface px-4 text-sm font-medium text-muted opacity-60"
            title="This cannot be done yet — the conditions underneath are what it is waiting on. That is a different refusal from not being allowed to do it."
          >
            {action.label}
          </span>
        ) : (
          <Link
            href={destinationFor(action.control, workspace, base).href}
            className={cx(
              "inline-flex h-9 items-center rounded-[4px] border px-4 text-sm font-medium no-underline hover:no-underline",
              LINK_SKIN[action.tone === "muted" ? "brand" : action.tone],
            )}
          >
            {action.label}
          </Link>
        )}

        {shut ? (
          <Pill tone="warn">{plural(verdict.missing.length, "thing")} missing</Pill>
        ) : null}
      </div>

      <p className="mt-1.5 mb-0 text-[13px] text-pretty text-body">
        {action.says}
        {action.control !== "advance" ? (
          <span className="text-muted">
            {" "}
            It is on {destinationFor(action.control, workspace, base).where}.
          </span>
        ) : null}
      </p>

      {shut ? (
        <ul className="mt-2 mb-0 list-none p-0">
          {verdict.missing.map((c) => (
            <li key={c.id} className="text-[13px] text-warn-ink">
              · {c.says}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
