/**
 * Whether an order may be taken, and by whose authority.
 *
 * **Credit-blocked is the only outright block in the whole app.** Everything
 * else here — and everywhere else in MBOS — either flags for a manager or
 * routes to an approver. That is deliberate and it is the rule to remember
 * when adding anything to this file: a salesman standing in a shop is holding
 * a conversation, and an app that says "no" to him has ended it on his behalf.
 * A credit block is the one case where saying no is the whole point, because
 * accounts have already decided this customer does not get goods until
 * something is settled, and letting the order through would mean somebody
 * ringing the shop later to take it back.
 *
 * Everything above that is a threshold, and thresholds route rather than
 * refuse: over the limit is an approval, not a refusal.
 *
 * Money is paise, integers, everywhere. Pure — every figure arrives as an
 * argument, including both approval tiers.
 */

export type CreditDecision = 'blocked' | 'ok' | 'needs_approval';

/**
 * Which desk has to say yes. `none` where nobody does.
 *
 * Two tiers because the amounts differ by an order of magnitude in practice: a
 * few thousand over is an ASM's call made on the phone in two minutes, and a
 * lakh over is not.
 */
export type ApproverTier = 'none' | 'manager' | 'senior';

export type CreditAssessment = {
  decision: CreditDecision;
  /** The sentence shown to the salesman, in the shop, in front of the customer. */
  reason: string;
  /**
   * limit − outstanding − submitted-but-not-yet-invoiced. May be negative.
   * Null when there is no limit on file, which a screen must show as "not
   * known" — a zero here would read as "no headroom left".
   */
  availablePaise: number | null;
  /** How far past `available` this order goes. Zero when it fits. */
  overByPaise: number;
  /**
   * False when the limit or the order value was missing, so nothing was
   * actually compared. The order still goes; the office is told it went
   * unchecked.
   */
  checked: boolean;
  approverTier: ApproverTier;
};

export type CreditInputs = {
  /** Accounts' standing decision. The one thing here that refuses outright. */
  creditBlocked: boolean;
  /**
   * Null where no limit has been set for this customer. That is not an infinite
   * limit and it is not a zero one — it is a question nobody has answered, so
   * the order passes and says the limit could not be checked.
   */
  creditLimitPaise: number | null;
  /** Confirmed, invoiced, unpaid. The office's figure, never the handset's. */
  outstandingPaise: number;
  /**
   * Orders this salesman has already placed that have not become invoices yet.
   * Leaving this out is how a salesman takes four orders in a morning, each of
   * which fits the limit on its own, and the customer ends the day three lakh
   * past it with nobody having done anything wrong.
   */
  submittedPaise: number;
  /**
   * Null where the order cannot be valued at all — which, until a price source
   * is confirmed, is every order (see `order.ts`). An unvalued order is not a
   * zero-rupee order, so it is not silently waved through as fitting; it passes
   * with the limit unchecked and says so, for the office to price and decide.
   */
  orderValuePaise: number | null;
  /**
   * The overshoot the desk absorbs without anybody being asked. Set it to zero
   * and every rupee over the limit routes to a manager; set it to ₹5,000 and a
   * shop that rounds its order up does not cost somebody a phone call. It is
   * configuration precisely because the right answer differs by territory.
   */
  approvalThresholdPaise: number;
  /** Over-by beyond this goes to the senior desk rather than the manager. */
  secondTierThresholdPaise: number;
};

/**
 * `available = creditLimitPaise − outstandingPaise − submittedNotInvoicedPaise`
 *
 * Broken out because three screens show this number and they must not each
 * compute their own version of it.
 */
export function availableCreditPaise(inputs: {
  creditLimitPaise: number | null;
  outstandingPaise: number;
  submittedPaise: number;
}): number | null {
  if (inputs.creditLimitPaise == null) return null;
  return inputs.creditLimitPaise - inputs.outstandingPaise - inputs.submittedPaise;
}

export function assessOrder(inputs: CreditInputs): CreditAssessment {
  const availablePaise = availableCreditPaise(inputs);
  const checked = availablePaise != null && inputs.orderValuePaise != null;
  const overByPaise = checked
    ? Math.max(0, inputs.orderValuePaise! - availablePaise!)
    : 0;

  // Asked first, and it does not matter what the numbers say. A blocked
  // customer with a crore of headroom is still blocked; the block is a
  // decision, not a calculation, and a calculation must not overturn it.
  if (inputs.creditBlocked) {
    return {
      decision: 'blocked',
      reason: 'This customer is credit-blocked. Accounts have to lift it before an order can be taken.',
      availablePaise,
      overByPaise,
      checked,
      approverTier: 'none',
    };
  }

  if (!checked) {
    // Nothing was compared, so nothing may be claimed. The order goes — this is
    // not a block — and the sentence says which half was missing, because "no
    // limit on file" is an office job and "no price yet" is a different one.
    return {
      decision: 'ok',
      reason:
        availablePaise == null
          ? 'No credit limit on file for this customer, so the limit was not checked.'
          : 'This order cannot be valued yet, so it was not checked against the credit limit.',
      availablePaise,
      overByPaise: 0,
      checked: false,
      approverTier: 'none',
    };
  }

  if (overByPaise <= inputs.approvalThresholdPaise) {
    return {
      decision: 'ok',
      reason:
        overByPaise === 0
          ? 'Within the credit limit.'
          : 'Just past the credit limit, inside the allowance — no approval needed.',
      availablePaise,
      overByPaise,
      checked: true,
      approverTier: 'none',
    };
  }

  // Over the limit is an approval, never a refusal. The order is taken, the
  // customer is told it is subject to approval, and somebody with the authority
  // decides — which is the same shape as everything else in MBOS.
  const approverTier: ApproverTier =
    overByPaise > inputs.secondTierThresholdPaise ? 'senior' : 'manager';

  return {
    decision: 'needs_approval',
    reason:
      approverTier === 'senior'
        ? 'This goes well past the credit limit — it needs the senior desk to approve before it ships.'
        : 'This goes past the credit limit — it needs your manager to approve before it ships.',
    availablePaise,
    overByPaise,
    checked: true,
    approverTier,
  };
}
