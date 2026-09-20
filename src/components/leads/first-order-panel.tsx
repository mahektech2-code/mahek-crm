"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, parseRupees, shortDate } from "@/lib/format";
import { FIRST_ORDER_QUESTIONS } from "@/lib/lead-labels";
import {
  commitmentGap,
  commitmentSizeLabel,
  commitmentState,
} from "@/lib/lead-commitment";
import { askForFirstOrder } from "@/lib/actions/leads";
import { Button } from "@/components/console/parts";
import { ConfirmOrderPanel } from "./confirm-order-panel";

/**
 * §18 — asking for the order, and "customer interested" is not an answer.
 *
 * The specification is explicit about it, and the eight questions are the whole
 * of the argument: a manager who records interest has recorded nothing, and the
 * lead sits for a fortnight while everybody assumes it is moving. Every one of
 * these has an answer a customer can give on a phone call, and the last four
 * are the four things that actually stop an order — price, credit, a
 * competitor, delivery. Naming which one it is turns "he is thinking about it"
 * into something somebody can go and fix.
 *
 * **THE DAY IS REQUIRED, AND A SIZE IS WHAT MAKES IT A COMMITMENT.** §3.4:
 * an expected order date AND an expected quantity or an expected value. The
 * date is what the gate to `first_order` reads and what the nurture sequence
 * fires from, so a call that did not produce one has not asked the question —
 * but a day on its own is a follow-up, and `lib/lead-commitment.ts` is the one
 * place that is decided, read here and by every service that counts one.
 *
 * **The form does not refuse a day with no size, and that is deliberate.** A
 * customer who says "around the 25th" and cannot say how much has told the
 * salesman something real, and a screen that threw it away for want of a
 * figure nobody gave would teach him either to invent one or to stop
 * recording the call. What it does instead is SAY, before he presses the
 * button and again in the strip afterwards, that this will not be counted in
 * the forecast — which is the only version of this he can act on, because he
 * is the one who can ring back and ask.
 *
 * The quantity is in CANS and the value is an estimate: the product master
 * carries no prices, `canValueOrders()` answers no, and either one satisfies
 * the rule because at commitment there is usually no SKU to convert between
 * them.
 */
export function FirstOrderPanel({
  customerId,
  expectedOrderDate,
  expectedOrderCans,
  expectedOrderValuePaise,
  countingOrderCount,
  pendingOrderCount,
  disabled,
  disabledReason,
}: {
  customerId: string;
  expectedOrderDate: string | null;
  /** CANS. Either this or the value is what makes the date a commitment. */
  expectedOrderCans: number | null;
  expectedOrderValuePaise: number | null;
  /** Once there is a real order the ask is history rather than a task. */
  countingOrderCount: number;
  /**
   * Orders already with accounts, where the screen knows. Passed straight
   * through to the confirmation card, whose own prose says why it cannot be
   * worked out from the count above it.
   */
  pendingOrderCount?: number;
  disabled: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [date, setDate] = React.useState(expectedOrderDate ?? "");
  const [cans, setCans] = React.useState(expectedOrderCans ? String(expectedOrderCans) : "");
  const [value, setValue] = React.useState(
    expectedOrderValuePaise ? String(Math.round(expectedOrderValuePaise / 100)) : "",
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* What is ON FILE, and what the form as it stands would record. Both are
     derived from props and state during render rather than kept in an effect:
     a second copy of the verdict is a copy that can disagree with the one the
     action writes. */
  const saved = commitmentState({
    expectedOrderDate,
    expectedOrderCans,
    expectedOrderValuePaise,
  });
  const pending = commitmentState({
    expectedOrderDate: date || null,
    expectedOrderCans: parseCans(cans),
    expectedOrderValuePaise: parseRupees(value),
  });

  async function submit() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await askForFirstOrder(customerId, {
        answers,
        expectedDate: date,
        expectedCans: parseCans(cans) ?? undefined,
        expectedValuePaise: parseRupees(value) ?? undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Recorded.");
    router.refresh();
  }

  return (
    <>
    <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Ask for the first order
          </div>
          <p className="mt-1 max-w-[520px] text-[12px] text-pretty text-muted">
            Eight questions with answers a customer can give on a call. &ldquo;Customer
            interested&rdquo; is not one of them.
          </p>
        </div>
        <Button
          size="sm"
          tone="primary"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => setOpen(true)}
        >
          {expectedOrderDate ? "Ask again" : "Ask"}
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
        <Fact
          label="They said they will place it"
          value={expectedOrderDate ? shortDate(expectedOrderDate) : "Nobody has asked"}
        />
        <Fact
          label="How much they said"
          value={
            expectedOrderDate
              ? commitmentSizeLabel(
                  { expectedOrderDate, expectedOrderCans, expectedOrderValuePaise },
                  money,
                )
              : "Nobody has asked"
          }
        />
        <Fact
          label="Orders on the account"
          value={countingOrderCount ? String(countingOrderCount) : "None yet"}
        />
      </div>

      {/*
        WHICH OF THE TWO IS ON FILE, said in the strip rather than left to be
        worked out from a blank figure. A date with nothing beside it reads as
        a promise on every screen it appears on, and the person who can turn it
        into one is the salesman reading this — so the sentence names what is
        missing and says plainly that the forecast is not counting it.
      */}
      {expectedOrderDate ? (
        <p className="mt-2 max-w-[560px] text-[12px] text-pretty text-muted">
          {saved === "confirmed"
            ? "A day and a size — counted as a commitment, and still a forecast rather than a sale."
            : commitmentGap({
                expectedOrderDate,
                expectedOrderCans,
                expectedOrderValuePaise,
              })}
        </p>
      ) : null}

      <Modal open={open} onClose={() => setOpen(false)} title="Ask for the first order" width={680}>
        <div className="grid max-h-[46vh] grid-cols-2 gap-x-4 gap-y-2.5 overflow-y-auto pr-1">
          {FIRST_ORDER_QUESTIONS.map((q) => (
            <label key={q.id} className="block">
              <span className="mb-1 block text-[13px] text-body">{q.ask}</span>
              <input
                value={answers[q.id] ?? ""}
                onChange={(e) =>
                  setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
          ))}
        </div>

        {/*
          WHY THERE ARE TWO PLACES TO SAY "HOW MUCH", and they are not the same
          answer. The question above takes the customer's own words in whatever
          unit he used — "about five hundred litres", "a drum a month" — and
          that sentence is what the timeline keeps. The box below is the
          countable figure, in cans, and only a number can be added up or
          weighed against a day. Neither is a copy of the other, and the words
          are never parsed into the figure: reading "a drum" as one can is the
          kind of guess that puts a wrong number on a forecast.
        */}
        <p className="mt-4 text-[12px] text-pretty text-muted">
          §3.4 — a day AND a quantity or a value is a commitment. A day on its own
          is recorded as an expected order and is not counted in the forecast.
        </p>

        <div className="mt-2 grid grid-cols-1 gap-4 border-t border-divider pt-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Date they said · required
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              This is what the gate reads and what the follow-up fires from.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Expected quantity (cans)
            </span>
            <input
              value={cans}
              onChange={(e) => setCans(e.target.value)}
              inputMode="numeric"
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              Cans, because that is what a customer counts in. Either this or the
              value makes the day a commitment.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Expected value (rupees)
            </span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="numeric"
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              An estimate. Nothing in MahekOne can price an order yet.
            </span>
          </label>
        </div>

        {/*
          SAID BEFORE THE BUTTON IS PRESSED, not after it. Being told that a
          record does not count once it is already saved is how somebody
          learns the screen is against them; told beforehand, the answer is
          one more question on a call he is still on.
        */}
        {pending === "expected" ? (
          <p className="mt-3 text-[12px] text-pretty text-muted">
            {commitmentGap({
              expectedOrderDate: date || null,
              expectedOrderCans: parseCans(cans),
              expectedOrderValuePaise: parseRupees(value),
            })}
          </p>
        ) : null}

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || !date}
            title={!date ? "Ask when they will place it. That date is the whole answer." : undefined}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : pending === "confirmed" ? "Record the commitment" : "Record it"}
          </Button>
        </div>
      </Modal>
    </section>

    {/*
      §5.5's SECOND ACT, DRAWN FROM THE FIRST, because the two are one subject
      and the second only exists once the first has happened. Mounted here
      rather than by each screen: this component is what every Commercial
      surface already renders — the record's tab, the commitments worklist and
      the first-order worklist — and adding the confirmation to three call
      sites is how one of them comes to be missing it. §7's instruction is
      surfaced on all three or on none.

      THE SAME TWO FACTS THE CARD FORKS ON, and read from the same places:
      `commitmentState` on the stored columns, which is `hasCommitment`, and
      `countingOrderCount`, which is `hasOrder`. Not re-derived and not a
      second opinion — `gateAction` routes a manager here on exactly this pair,
      so drawing the form on anything else would send him to a card that is not
      there.
    */}
    {saved === "confirmed" && countingOrderCount === 0 && expectedOrderDate ? (
      <ConfirmOrderPanel
        customerId={customerId}
        expectedOrderDate={expectedOrderDate}
        expectedOrderCans={expectedOrderCans}
        expectedOrderValuePaise={expectedOrderValuePaise}
        pendingOrderCount={pendingOrderCount}
        disabled={disabled}
        disabledReason={disabledReason}
      />
    ) : null}
    </>
  );
}

/**
 * Cans, as a whole number, and nothing else is an answer.
 *
 * `parseRupees` beside it takes a decimal because money has paise; a can does
 * not come in halves at this end of the funnel, and "2.5" would be stored as
 * two or three by whoever rounded it first. Zero and anything unreadable come
 * back null, which the rule reads as no quantity given rather than as a
 * customer promising nothing.
 */
function parseCans(input: string): number | null {
  const cleaned = input.replace(/[^0-9]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span className="block text-body">{value}</span>
    </span>
  );
}
