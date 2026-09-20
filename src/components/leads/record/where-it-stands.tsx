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
  primaryVantage,
  vantageAsYou,
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
 * The reader's own instruction, and then everybody else's.
 *
 * §8.5 item 7 asks for the current role's computed badge "shown alongside" the
 * ladder, and §7 asks that the role-relativity be visible. Those are two
 * halves of one section: the reader's own reading has to be the PRIMARY one —
 * they opened this page to find out what to do — and the other four have to be
 * underneath it, labelled, because "Sales Manager sees: Confirm actual order"
 * is the sentence that tells a salesman the ball is not in his court.
 *
 * `vantageAsYou` rather than `vantageLabel` on the reader's own line, because
 * a heading carrying somebody else's job title reads as a line about somebody
 * else. The other four are named with the plain label and the verb "sees",
 * which is the specification's own phrasing and is deliberately not "must" —
 * this section reports what the product is asking of people; it does not
 * assign anything.
 *
 * EVERY VANTAGE THE READER HOLDS IS MARKED rather than removed from the list
 * below. On nine people several is the ordinary case — a sales manager is
 * routinely also the named back office person on one lead — and a table with
 * one row quietly missing is one nobody can count against the specification.
 */
export function RoleReadings({
  facts,
  viewer,
  seats,
}: {
  facts: LeadActionFacts;
  viewer: VantageViewer;
  seats: VantageSeats;
}) {
  const mine = new Set<LeadVantage>(vantagesFor(viewer, seats));
  const own = primaryVantage(viewer, seats);

  return (
    <div className="mb-3 border-b border-divider pb-3">
      {own ? (
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[13px] font-medium text-ink">{vantageAsYou(own)}</span>
          <ActionPill action={roleAction(facts, own)} />
        </div>
      ) : (
        /* NO VANTAGE IS SAID IN WORDS rather than drawn as an empty strip. It
           is a real answer — somebody holding the leads module through an app
           that gives them no job on this particular shop — and inventing an
           instruction for them would put a telecaller's verb in front of an
           accounts clerk. The five readings below still draw, because "what is
           owed, and by whom" is a question worth answering to somebody who is
           owed none of it. */
        <div className="text-[13px] text-muted">
          Nobody has put you on this lead and none of your apps gives you a job on it. What it
          reads as to the people who do:
        </div>
      )}

      {/* Wraps rather than scrolls: five short phrases stack in a rail on a
          desk and on a phone alike, and a sideways scroll inside a panel is a
          thing nobody finds. */}
      <ul className="mt-2 mb-0 flex list-none flex-col gap-1.5 p-0">
        {LEAD_VANTAGES.filter((v) => v !== own).map((v) => (
          <li key={v} className="flex flex-wrap items-baseline gap-1.5 text-[13px]">
            <span className="text-muted">
              {vantageLabel(v)}
              {mine.has(v) ? " · also you" : ""} sees
            </span>
            <ActionPill action={roleAction(facts, v)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
