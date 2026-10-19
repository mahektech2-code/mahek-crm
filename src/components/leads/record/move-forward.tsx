"use client";

import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import {
  gateAction,
  type LeadGateActionFacts,
  type LeadGateControl,
} from "@/lib/engines/lead-gate-action";

/* ---------------------------------------------------------------------------
 * §8.5 — WHAT DO I DO NEXT ON THIS LEAD, as the record header's one button.
 *
 * TWO ENGINES AND NEITHER IS SECOND-GUESSED. `gateAction` says what this
 * rung's work IS; `gateForNext` says whether it has been done, and the gate
 * card under the header draws that answer with `AdvanceStage` — unchanged, the
 * one write path for a move. This file draws only the acts done on another
 * screen (the verification call, the Qualification, the sample desk, the
 * commitment, the approval chain), as a link to where they are done.
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
    case "qualify":
      return { href: `${base}/qualify`, where: "the Qualification screen" };
    case "sample_desk":
      return { href: leadHref(workspace, "samples/desk"), where: "the sample desk" };
    case "record_commitment":
    case "confirm_order":
      return { href: `${base}?tab=commercial`, where: "the Orders & money tab" };
    case "management_approval":
      return { href: `${base}?tab=approval`, where: "the approval chain" };
  }
}

/**
 * The record header's primary button: the rung's act where it is done on
 * another screen — the verification call, the Qualification, the sample desk,
 * the commitment, the approval chain. A move up the ladder itself is the gate
 * card's own button, so `advance` and `none` draw nothing here.
 *
 * The verification call is the one act gated by who is reading: only somebody
 * who may verify gets it live, as the old banner's "Make the call" did. Every
 * other destination is a screen that enforces its own rules.
 */
export function PrimaryGateAction({
  workspace,
  base,
  facts,
  canVerify,
}: {
  workspace: LeadWorkspace;
  base: string;
  facts: LeadGateActionFacts;
  canVerify: boolean;
}) {
  const action = gateAction(facts);
  if (action.control === "none" || action.control === "advance") return null;
  const dest = destinationFor(action.control, workspace, base);
  const off = action.control === "verify" && !canVerify;
  return (
    <Link
      href={dest.href}
      aria-disabled={off || undefined}
      title={off ? "Only a Sales Manager can make the check call." : action.says}
      className={cx(
        "inline-flex h-9 items-center rounded-[6px] border px-4 text-sm font-medium whitespace-nowrap no-underline hover:no-underline",
        off
          ? "pointer-events-none border-line bg-surface text-muted opacity-50"
          : "border-brand bg-brand text-white hover:bg-brand-hover hover:text-white",
      )}
    >
      {action.label}
    </Link>
  );
}
