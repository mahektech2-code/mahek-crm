/* ---------------------------------------------------------------------------
 * What one claim is worth, and what the day has left.
 *
 * PURE, and that is the whole reason it is here rather than beside the SQL it
 * used to live next to. `data/travel.ts` imports `../db` at module scope, so
 * anything in it drags expo-sqlite and React Native into the process and no
 * test runner can load it — the same trap `engines/cadence.ts` records, where
 * a cadence nobody could exercise without a handset was wrong on every phone
 * for three days. These are the sentences a salesman reads before he decides
 * whether to spend, priced by the same engine the office pays on, and they had
 * no test because they could not have one.
 *
 * The policy arrives as an argument, like every other engine here. It performs
 * no I/O and reads no clock: the day is passed in, because the form has a date
 * picker and a claim made on Thursday is often for Tuesday.
 * ------------------------------------------------------------------------- */

import {
  computeDay,
  type ExpenseKind,
  type ExpenseLineFacts,
  type Policy,
  type PolicySubject,
} from './generated/expense-policy';
import { inrFromPaise } from '../lib/format';

/** What `data/travel.ts` holds for the policy in force — structurally. */
export type PricingPolicy = { policy: Policy; subject: PolicySubject };

/* ------------------------------------------------- what a claim is worth */

/**
 * A claim already standing on the day being claimed for.
 *
 * `kind` and not `category`: the two are different vocabularies and the ONE
 * place they part company is the one that matters here — `local_transport` is
 * stored under the category `travel` (see `CLAIM_KINDS`), so a day priced off
 * the category puts every auto fare under the wrong cap.
 */
export type ClaimedLine = {
  id: string;
  kind: ExpenseKind;
  claimedPaise: number;
  hasProof: boolean;
};

export type ClaimPreview = {
  eligiblePaise: number;
  excessPaise: number;
  /** True where the policy says nothing about this kind at all. */
  unpriced: boolean;
  /** The sentence under the amount box. Always says something. */
  line: string;
  /** Whether a bill is compulsory at this amount. */
  proofRequired: boolean;
  /** What the day has left BEFORE this claim. Null where no cap bites. */
  remainingBeforePaise: number | null;
  /** What would be left AFTER it. Null where no cap bites. */
  remainingAfterPaise: number | null;
};

/**
 * The id the previewed line is priced under, so the day's own exceptions can be
 * told apart from the ones this claim produces. Without it, a bill missing off
 * a line he settled this morning would light up the box he is typing in now.
 */
const PREVIEW_ID = 'preview';

/**
 * An amount no policy has a ceiling above, used to ASK the engine what is left
 * rather than to re-read the rules here.
 *
 * There is no "headroom" to read off a `DayComputation` — the engine answers
 * what a day is worth, not what more it could take — and the difference between
 * the day WITH a line and the day WITHOUT it only ever prices the line that was
 * actually typed. So the remainder is that same difference taken over lines
 * nothing could pay in full. Deriving it from the rules instead would be a
 * second reading of them on the one screen where he decides whether to spend,
 * and a cap this file has never heard of would go unreported.
 */
const PROBE_PAISE = 100_000_000;

/**
 * How many probe lines it takes to measure a DAY rather than one claim.
 *
 * One probe is not enough and the difference is the whole bug this replaced.
 * A ₹300-a-fare, ₹600-a-day policy trims a single probe to ₹300 — which is a
 * true answer to "what is the most this one claim can earn" and a false one to
 * "what is left today", and the sentence on the screen says today. Six auto
 * fares are an ordinary Tuesday; the per-claim cap is what he reads in the
 * excess line when he goes over.
 *
 * So the day is probed with a DOUBLING number of lines until the answer stops
 * changing. Convergence is the stopping rule rather than a count somebody
 * picked: a total that is still climbing at 1,024 lines is a kind this policy
 * puts no daily limit on at all, and that is reported as no limit rather than
 * as the largest figure we happened to reach. A wrong budget is worse than
 * none — he plans the afternoon on it.
 */
const PROBE_CEILING = 1024;

/**
 * What the policy allows for one claim, worked out on the phone.
 *
 * **The salesman must be shown the figure he will actually be paid**, and
 * before this the Expenses screen showed him a monthly headroom from the old
 * per-category caps in configuration — a different number, from a different
 * source, that the office does not pay on. Two answers to "what am I allowed",
 * and the one he read was the wrong one. That is precisely the drift the whole
 * policy module exists to remove, and it was still sitting on the one screen
 * where he decides whether to spend.
 *
 * **A CLAIM IS PRICED AGAINST ITS OWN DAY, not against an empty one.** This
 * priced a day of exactly one line — the claim being typed — so where the
 * policy carries a per-day cap it reported the WHOLE cap however much of it
 * had already gone. He is told ₹600 is allowed when ₹340 is left, types ₹500,
 * and finds out at approval, which is the one moment the sentence exists to
 * come before. `alreadyClaimed` is the rest of that day and `day` is the day
 * itself: the form has a date picker and he claims for a Tuesday on the
 * Thursday, so pricing against today would be the wrong day's total and, once
 * the office publishes a new version, the wrong day's rules.
 *
 * **The answer is a DIFFERENCE, never a re-reading.** What this line is worth
 * is the day computed with it less the day computed without it, which is the
 * only question that stays correct as the engine learns new ceilings: a cap
 * this file has never heard of shows up as a line that earns less. The legs and
 * the clock are still left empty, and that costs nothing for the same reason —
 * meals and mileage are equal on both sides of the subtraction and cancel.
 *
 * It uses the same `computeDay` the office uses. Nothing here refuses a claim:
 * over-policy is SAID, plainly, while he can still change it — and then sent
 * anyway, because the money is already spent.
 */
export function previewClaim(args: {
  policy: PricingPolicy | null;
  kind: ExpenseKind;
  claimedPaise: number;
  hasBill: boolean;
  /** The day being claimed FOR, `YYYY-MM-DD`. */
  day: string;
  /** What is already claimed on that day, this one excluded. */
  alreadyClaimed: readonly ClaimedLine[];
}): ClaimPreview {
  const { policy, kind, claimedPaise, hasBill, day, alreadyClaimed } = args;
  if (!policy) {
    return {
      eligiblePaise: 0,
      excessPaise: 0,
      unpriced: true,
      proofRequired: false,
      remainingBeforePaise: null,
      remainingAfterPaise: null,
      line: 'This phone has no policy yet — the office will work out what this is worth.',
    };
  }

  const standing: ExpenseLineFacts[] = alreadyClaimed.map((l) => ({
    id: l.id,
    kind: l.kind,
    claimedPaise: l.claimedPaise,
    hasProof: l.hasProof,
    nights: l.kind === 'lodging' ? 1 : undefined,
  }));

  const priceWith = (extra: ExpenseLineFacts | null) =>
    computeDay(policy.policy, policy.subject, {
      day,
      clock: { departedMinutes: null, returnedMinutes: null, arrivedAtDestinationMinutes: null },
      departedFromHometown: true,
      stayedInHotel: kind === 'lodging',
      overnight: kind === 'lodging',
      legs: [],
      lines: extra ? [...standing, extra] : standing,
    });

  const previewLine = (paise: number): ExpenseLineFacts => ({
    id: PREVIEW_ID,
    kind,
    claimedPaise: paise,
    hasProof: hasBill,
    nights: kind === 'lodging' ? 1 : undefined,
  });

  const without = priceWith(null);

  /* What a day of this kind could still take, measured rather than derived.
     `probeAt` prices the standing day plus n lines nothing could pay in full;
     the answer stops climbing exactly where the day's own limit is. */
  const probeAt = (n: number) =>
    Math.max(
      0,
      computeDay(policy.policy, policy.subject, {
        day,
        clock: { departedMinutes: null, returnedMinutes: null, arrivedAtDestinationMinutes: null },
        departedFromHometown: true,
        stayedInHotel: kind === 'lodging',
        overnight: kind === 'lodging',
        legs: [],
        lines: [
          ...standing,
          ...Array.from({ length: n }, (_, i) => ({ ...previewLine(PROBE_PAISE), id: `${PREVIEW_ID}:${i}` })),
        ],
      }).totalEligiblePaise - without.totalEligiblePaise,
    );

  let headroom: number | null = null;
  let seen = probeAt(1);
  for (let n = 2; n <= PROBE_CEILING; n *= 2) {
    const next = probeAt(n);
    if (next === seen) {
      headroom = seen;
      break;
    }
    seen = next;
  }

  const probe = priceWith(previewLine(PROBE_PAISE));

  /* A hotel night this policy has never priced comes back eligible for nothing,
     which is the same shape as a cap fully spent and a completely different
     sentence: "nothing left for hotel today" would read as a limit he has used
     up, on a day where the office has simply never said what a room may cost.
     The engine already distinguishes them in words, so it is asked rather than
     guessed at. */
  const priceless = probe.exceptions.some(
    (e) => e.lineId === PREVIEW_ID && e.kind === 'unpriced_lodging',
  );
  const remainingBefore = headroom === null || priceless ? null : headroom;
  const what = CLAIM_KINDS.find((k) => k.key === kind)?.label.toLowerCase() ?? kind.replace(/_/g, ' ');

  /* **Said BEFORE he types, which is the whole of "while it can still be
     changed".** A headroom that only appears once the amount is wrong is a
     headroom he reads as an accusation rather than as a budget. */
  if (claimedPaise <= 0) {
    return {
      eligiblePaise: 0,
      excessPaise: 0,
      unpriced: false,
      proofRequired: false,
      remainingBeforePaise: remainingBefore,
      remainingAfterPaise: remainingBefore,
      line:
        remainingBefore === null
          ? ''
          : remainingBefore > 0
            ? `${inrFromPaise(remainingBefore)} left for ${what} today.`
            : `Nothing left for ${what} today — anything you claim now needs your manager to agree it.`,
    };
  }

  const computed = priceWith(previewLine(claimedPaise));
  const eligible = Math.max(0, computed.totalEligiblePaise - without.totalEligiblePaise);
  const excess = Math.max(0, claimedPaise - eligible);
  const remainingAfter = remainingBefore === null ? null : Math.max(0, remainingBefore - eligible);
  const proofRequired = computed.exceptions.some(
    (e) => e.lineId === PREVIEW_ID && e.kind === 'missing_proof',
  );

  if (excess > 0) {
    return {
      eligiblePaise: eligible,
      excessPaise: excess,
      unpriced: false,
      proofRequired,
      remainingBeforePaise: remainingBefore,
      remainingAfterPaise: remainingAfter,
      line: `The policy allows ${inrFromPaise(eligible)} of this. The other ${inrFromPaise(excess)} needs your manager to agree it — send it anyway and say why.`,
    };
  }
  if (proofRequired && !hasBill) {
    return {
      eligiblePaise: eligible,
      excessPaise: 0,
      unpriced: false,
      proofRequired,
      remainingBeforePaise: remainingBefore,
      remainingAfterPaise: remainingAfter,
      line: 'This much needs the bill photographed before it can be settled.',
    };
  }
  return {
    eligiblePaise: eligible,
    excessPaise: 0,
    unpriced: false,
    proofRequired,
    remainingBeforePaise: remainingBefore,
    remainingAfterPaise: remainingAfter,
    line:
      remainingAfter === null
        ? `Within policy — ${inrFromPaise(eligible)}.`
        : remainingAfter > 0
          ? `Within policy — ${inrFromPaise(eligible)}. ${inrFromPaise(remainingAfter)} left for ${what} today.`
          : `Within policy — ${inrFromPaise(eligible)}. Nothing left for ${what} today.`,
  };
}

/**
 * The kinds a salesman may claim, and the legacy CATEGORY each one is stored
 * under.
 *
 * Two fields because they are two different vocabularies and always were:
 * `mbos_expense_category` has exactly four values and the server refuses a
 * fifth, so `local_transport` — a kind the policy prices separately — is
 * stored as the category `travel`, which is what it is. Sending the kind as
 * the category would get every auto fare rejected as invalid.
 */
export const CLAIM_KINDS: { key: ExpenseKind; category: string; label: string }[] = [
  { key: 'food', category: 'food', label: 'Food' },
  { key: 'lodging', category: 'lodging', label: 'Hotel' },
  { key: 'local_transport', category: 'travel', label: 'Local transport' },
  { key: 'other', category: 'other', label: 'Other' },
];