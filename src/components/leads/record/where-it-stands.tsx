"use client";

import { Pill } from "@/components/console/parts";
import {
  roleAction,
  type LeadAction,
  type LeadActionFacts,
  type LeadVantage,
} from "@/lib/engines/lead-role-action";
import {
  LEAD_VANTAGES,
  vantagesFor,
  vantageLabel,
  type VantageSeats,
  type VantageViewer,
} from "@/lib/lead-vantage";

/* ---------------------------------------------------------------------------
 * §7 ON THE RECORD, which is the screen the decision is actually made on.
 *
 * `roleAction` is the specification's own "single most important piece of
 * business logic", and until this landed it was drawn in exactly ONE place:
 * the leads list's "For you" column, plus the five readings in its expanded
 * row. The record — the page somebody opens to decide what to do about one
 * shop — drew neither. So the screen with the most room for the answer, and
 * the one where somebody is about to act, was the screen that never said whose
 * move it was.
 *
 * WHAT IT ADDS OVER THE LADDER BESIDE IT is the difference between a NOUN and
 * a VERB. "The climb" says which rung this lead stands on and what the next
 * one is waiting for; neither of those is an instruction, and neither of them
 * changes with who is reading. A lead in Negotiation with a commitment on file
 * is "Confirm actual order" to the sales manager and "Negotiation visit" to
 * the salesman on the same afternoon — two people each waiting for the other,
 * which is a fact about the lead that the rung cannot express and that nothing
 * else on this page says.
 *
 * NOTHING HERE IS RE-DERIVED. `roleAction` decides the words and the tone,
 * `vantagesFor` decides which of the five jobs the reader is doing on this
 * row, and both are the same functions the list calls. A second copy typed
 * into a screen drifts inside a release, and the half that drifts is always
 * the half somebody is reading.
 *
 * AND IT DECIDES NO RIGHTS. Both engine headers labour this and it is worth
 * repeating where the sentences are drawn: a vantage is not a role and a
 * sentence is not a permission. Every control on this page goes on asking its
 * own capability, and a reader who mistook this section for the security
 * boundary might delete a real check believing it redundant.
 * ------------------------------------------------------------------------- */

/**
 * How the four tones the engine returns are drawn.
 *
 * MUTED IS NOT A PILL, and that is the whole of the mapping's judgement.
 * `lead-role-action.ts` says in its own header that "Nothing operational
 * pending" drawn at the weight of "Payment follow-up" would be read as a task,
 * and a pill is exactly that weight — it is the shape this console uses for
 * something worth noticing. The three live tones get the house pill and the
 * fourth gets plain muted text, which is the absence of one rather than a
 * fourth colour. The tone is the ENGINE'S answer and this maps it; it does not
 * choose one. Several existing callers elsewhere in MahekOne write `warning`
 * where the value is `warn` and are silently drawn as ordinary, which is
 * exactly what a `Record` keyed on the union prevents.
 */
export function ActionPill({ action }: { action: LeadAction }) {
  if (action.tone === "muted") {
    return <span className="text-[13px] text-muted">{action.label}</span>;
  }
  return <Pill tone={action.tone}>{action.label}</Pill>;
}

/**
 * "Who's up" — every vantage and what this lead asks of it, one row each,
 * the reader's own marked. The same `roleAction` readings as above, laid out
 * as the record's right rail draws them.
 */
export function WhosUp({
  facts,
  viewer,
  seats,
}: {
  facts: LeadActionFacts;
  viewer: VantageViewer;
  seats: VantageSeats;
}) {
  const mine = new Set<LeadVantage>(vantagesFor(viewer, seats));
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {LEAD_VANTAGES.map((v) => (
        <li key={v} className="flex items-center gap-2.5">
          <span className="w-[120px] flex-none text-[13px] text-body">
            {vantageLabel(v)}
            {mine.has(v) ? <span className="text-muted"> · you</span> : null}
          </span>
          <span className="min-w-0 flex-1 [&>span]:!whitespace-normal">
            <ActionPill action={roleAction(facts, v)} />
          </span>
        </li>
      ))}
    </ul>
  );
}
