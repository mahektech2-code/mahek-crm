"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { money } from "@/lib/format";
import { setLeadPriority } from "@/lib/actions/lead-priority";
import {
  LEAD_PRIORITIES,
  priorityLabel,
  prioritySentence,
  type LeadPriority,
} from "@/lib/lead-priority";

/**
 * §4.1 — HOW HARD TO PUSH THIS LEAD, said on the record it is about.
 *
 * It sits in the header strip immediately beside Potential, and the placing is
 * the argument: those two carry the same three words and answer different
 * questions, so drawn apart they read as one fact stated twice and drawn
 * together they read as what they are — what the shop could spend, and whether
 * it is this fortnight's work. `lib/lead-priority.ts` has the full note.
 *
 * **IT IS A SELECT AND NOT A MODAL.** Every other write on this page opens one,
 * and rightly: closing a lead, passing a shut gate and handing a relationship
 * over all demand a reason, refuse without one, and are things somebody should
 * be made to stop and confirm. This demands nothing, writes one column,
 * notifies nobody and is undone by picking something else — a dialog in front
 * of it would be ceremony around a judgement a manager revises as they learn
 * about the shop, and ceremony is what stops people revising.
 *
 * **THE FIRST OPTION IS "NOT SET", ALWAYS OFFERED.** Taking a judgement back
 * off has to be as easy as making one, or the first priority typed in error
 * stands for ever and the field becomes one people are wary of. It is not the
 * same answer as Low: null says nobody has judged this lead, which is what
 * every row in the book says until somebody does, and Low says a manager
 * looked and it can wait.
 *
 * **WITHOUT THE CAPABILITY IT IS DRAWN AND DISABLED, with the reason on the
 * hover** — this product's own rule for a control somebody might reasonably
 * expect to hold. The value still SHOWS, because the salesman working the lead
 * is exactly who the manager is talking to when they set it. The action checks
 * the capability too; a disabled select is a fact about a component.
 */
export function LeadPriorityControl({
  customerId,
  priority,
  potentialPaise,
  canPrioritise,
}: {
  customerId: string;
  priority: LeadPriority | null;
  /** Quoted underneath, because the judgement is made AGAINST this figure. */
  potentialPaise: number | null;
  canPrioritise: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  /*
   * What is showing NOW, which is the server's answer until somebody picks
   * something and this component's own answer after — set here rather than
   * synced from the prop in an effect, which the React Compiler rules forbid
   * and which would fight the value somebody has just chosen while the save is
   * still in flight. A save that fails puts it back to what the server said.
   */
  const [chosen, setChosen] = React.useState<LeadPriority | "">(priority ?? "");
  const [busy, setBusy] = React.useState(false);

  async function save(next: LeadPriority | "") {
    const previous = chosen;
    setChosen(next);
    setBusy(true);
    try {
      const result = await setLeadPriority({
        customerId,
        /* "" reaches the server as an explicit null — "unjudged" is a thing
           somebody chose rather than a field that fell off the form. */
        priority: next === "" ? null : next,
      });
      if (!result.ok) {
        setChosen(previous);
        toast.push(result.error, "error");
        return;
      }
      toast.push(result.message ?? "Saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="block min-w-0">
      <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        Priority
      </span>
      <select
        value={chosen}
        disabled={!canPrioritise || busy}
        onChange={(e) => void save(e.target.value as LeadPriority | "")}
        title={
          canPrioritise
            ? "How hard a manager has asked for this one to be pushed. Not what the shop is worth."
            : "Deciding which leads the team pushes is a manager's. Yours is not one of the hats that carries it."
        }
        className="mt-0.5 h-8 rounded-[4px] border border-line bg-surface px-2 text-[15px] font-medium text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">{priorityLabel(null)}</option>
        {LEAD_PRIORITIES.map((v) => (
          <option key={v} value={v}>
            {priorityLabel(v)}
          </option>
        ))}
      </select>
      <span className="block max-w-[240px] text-[12px] text-pretty text-muted">
        {prioritySentence(chosen === "" ? null : chosen)}
        {potentialPaise
          ? ` Against ${money(potentialPaise)} a month.`
          : " Nobody has estimated what this shop could spend."}
      </span>
    </span>
  );
}
