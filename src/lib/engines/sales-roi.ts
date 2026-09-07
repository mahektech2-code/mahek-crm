/* ---------------------------------------------------------------------------
 * E14 — §K and §L. What a salesman costs, what he brought in, and the two
 * customer-cost figures the brief asks to be kept apart.
 *
 * Pure. Every figure arrives as an argument.
 *
 * **THESE ARE REVENUE RATIOS, NOT MARGIN RATIOS, AND THE SCREENS SAY SO.**
 * Requirements 61 and 64 ask to compare "contribution" against cost, and
 * contribution is margin. MahekOne holds no prices and no costs at all —
 * `products.priceSource` is `unset` and `canValueOrders()` answers no, by
 * design, so that no screen shows a confident wrong figure. An order is worth
 * what was billed, not what it earned.
 *
 * So `marginBps` is an OPTIONAL argument on every function that would use one,
 * and where it is absent the result is labelled `revenue` rather than
 * `contribution`. The day a cost source exists — a price list, or one flat
 * margin percentage per formulation — it is one argument to one function and
 * the same screens become true ROI. Inventing a margin here to make the words
 * match would put a believable wrong number on the one screen where a wrong
 * number does the most damage.
 * ------------------------------------------------------------------------- */

export type Basis = "revenue" | "contribution";

/* --------------------------------------------------------------- §K ratios */

export type SalesmanPeriod = {
  userId: string;
  name: string;
  /** Paise, from orders that COUNT — approved, never merely captured. */
  revenuePaise: number;
  /** Metres, from `chosenMetres` on the legs. Not GPS, not the odometer: what was PAID on. */
  metres: number;
  visitCount: number;
  newCustomerCount: number;
  /** Paise. APPROVED expenses only — see the note on `totalCost`. */
  travelPaise: number;
  foodPaise: number;
  lodgingPaise: number;
  otherPaise: number;
  /** Paise, from the HRMS mirror. Null where payroll has no row for them. */
  salaryPaise: number | null;
};

/**
 * A ratio, and whether it could be worked out at all.
 *
 * Null with a reason rather than zero, throughout this file. Sales per
 * kilometre on a day nobody travelled is not ₹0 — it is a question with no
 * denominator, and a zero on that row reads as "he sold nothing".
 */
export type Ratio = {
  value: number | null;
  reason: string | null;
};

function ratio(top: number, bottom: number, whenZero: string): Ratio {
  if (bottom <= 0) return { value: null, reason: whenZero };
  return { value: top / bottom, reason: null };
}

/** Requirement 57. Paise of revenue per kilometre travelled. */
export function salesPerKm(p: Pick<SalesmanPeriod, "revenuePaise" | "metres">): Ratio {
  return ratio(p.revenuePaise, p.metres / 1000, "No distance was recorded, so there is nothing to divide by.");
}

/** Requirement 58. Paise of revenue per customer visit. */
export function salesPerVisit(p: Pick<SalesmanPeriod, "revenuePaise" | "visitCount">): Ratio {
  return ratio(p.revenuePaise, p.visitCount, "No visits were logged in this period.");
}

/**
 * Requirement 59. Travel expense as a percentage of revenue, in basis points.
 *
 * The denominator is REVENUE and it is the one that can be zero — a month
 * spent opening a new territory has travel and no sales, and the honest answer
 * is "there is no ratio yet", not infinity and not 100%.
 */
export function travelExpenseRatioBps(
  p: Pick<SalesmanPeriod, "revenuePaise" | "travelPaise">,
): Ratio {
  if (p.revenuePaise <= 0) {
    return {
      value: null,
      reason: "Nothing was sold in this period, so travel cannot be a share of it.",
    };
  }
  return { value: Math.round((p.travelPaise / p.revenuePaise) * 10_000), reason: null };
}

export type CostBreakdown = {
  salaryPaise: number;
  travelPaise: number;
  foodPaise: number;
  lodgingPaise: number;
  otherPaise: number;
  totalPaise: number;
  /** True where payroll has no figure, so the total is expenses alone. */
  salaryMissing: boolean;
};

/**
 * Requirement 60 — salary plus every approved expense.
 *
 * **Approved, never claimed.** Money the business has agreed to pay is the
 * only cost figure that means anything, and it is the same rule the payments
 * module already follows for reported against confirmed money. A cost built
 * from claims would move every time somebody submitted one and move back when
 * it was refused.
 *
 * Where payroll has no row the total is the expenses alone and `salaryMissing`
 * says so. Treating a missing salary as zero would make whoever payroll has
 * not caught up with look like the cheapest person on the team.
 */
export function totalSalesmanCost(p: SalesmanPeriod): CostBreakdown {
  const salary = p.salaryPaise ?? 0;
  return {
    salaryPaise: salary,
    travelPaise: p.travelPaise,
    foodPaise: p.foodPaise,
    lodgingPaise: p.lodgingPaise,
    otherPaise: p.otherPaise,
    totalPaise: salary + p.travelPaise + p.foodPaise + p.lodgingPaise + p.otherPaise,
    salaryMissing: p.salaryPaise === null,
  };
}

export type ReturnFigure = {
  basis: Basis;
  /** What the person brought in, on the stated basis. */
  returnedPaise: number;
  costPaise: number;
  /** Times cost. Null where there is no cost to divide by. */
  multiple: number | null;
  /** Returned less cost. */
  netPaise: number;
  /** Set where the basis is revenue: the sentence a screen has to print. */
  caveat: string | null;
};

/**
 * Requirement 61.
 *
 * With no `marginBps` this is revenue against cost, and `caveat` carries the
 * sentence every screen showing it must print. It is not a footnote to be
 * dropped when the layout gets tight: revenue over cost looks like a return on
 * investment, reads like one, and is off by whatever the margin is.
 */
export function salesmanReturn(
  p: SalesmanPeriod,
  cost: CostBreakdown,
  marginBps?: number | null,
): ReturnFigure {
  const hasMargin = typeof marginBps === "number" && marginBps > 0;
  const returned = hasMargin ? Math.round((p.revenuePaise * marginBps!) / 10_000) : p.revenuePaise;
  return {
    basis: hasMargin ? "contribution" : "revenue",
    returnedPaise: returned,
    costPaise: cost.totalPaise,
    multiple: cost.totalPaise > 0 ? returned / cost.totalPaise : null,
    netPaise: returned - cost.totalPaise,
    caveat: hasMargin
      ? null
      : "This is revenue against cost, not profit against cost. MahekOne holds no product costs, so no margin can be worked out — the figure is a ratio of turnover to what the person cost.",
  };
}

/* -------------------------------------------------- §L acquisition vs service */

/**
 * Which side of the line a piece of spending falls.
 *
 * **Requirement 65 is the whole reason this is one function.** Two readings of
 * "was this about winning a customer" in two services is how the two figures
 * come to overlap, and once they overlap neither is worth anything — the
 * acquisition cost is flattered by the servicing that leaked out of it.
 *
 * The rule: a leg or a line whose PURPOSE was winning a customer is
 * acquisition; against a customer who had already ordered before this date it
 * is servicing, whatever the purpose says. And spending attached to no
 * customer at all is neither, counted as `unattributed` and printed — the
 * same discipline `sales-attribution.ts` follows, because a figure nobody can
 * account for is worse than one that says why it is there.
 */
export type SpendItem = {
  id: string;
  paise: number;
  /** `visit` | `collection` | `complaint` | `new_customer` | `delivery` | ... */
  purpose: string | null;
  customerId: string | null;
  /** Whether that customer had a counting order before this spending happened. */
  customerHadOrderedBefore: boolean | null;
};

export type SpendSplit = {
  acquisitionPaise: number;
  servicingPaise: number;
  unattributedPaise: number;
  acquisitionIds: string[];
  servicingIds: string[];
  unattributedIds: string[];
};

/**
 * The purposes a salesman picks when he means "I am trying to win this shop".
 *
 * NOT used to decide the split — the order history decides that, above. It is
 * exported so a screen can say when the two disagree: "logged as a new-customer
 * call against an account that ordered in March" is a useful sentence, and it
 * is a sentence about the purpose field rather than about the money.
 */
export const ACQUISITION_PURPOSES: ReadonlySet<string> = new Set([
  "new_customer",
  "prospecting",
  "lead",
]);

/** Whether what the salesman meant and what the book says disagree. */
export function purposeDisagreesWithHistory(item: SpendItem): boolean {
  if (!item.purpose || item.customerHadOrderedBefore === null) return false;
  return ACQUISITION_PURPOSES.has(item.purpose) && item.customerHadOrderedBefore;
}

export function splitSpend(items: readonly SpendItem[]): SpendSplit {
  const split: SpendSplit = {
    acquisitionPaise: 0,
    servicingPaise: 0,
    unattributedPaise: 0,
    acquisitionIds: [],
    servicingIds: [],
    unattributedIds: [],
  };

  for (const item of items) {
    /* No customer, or no way to tell whether they had bought before, is
       UNATTRIBUTED — counted and printed rather than pushed into whichever
       side needs padding. The same discipline `sales-attribution.ts` follows:
       a figure nobody can account for is worse than one that says why it is
       there. Guessing here would land in exactly the two numbers requirement
       65 says must not contaminate each other. */
    if (!item.customerId || item.customerHadOrderedBefore === null) {
      split.unattributedPaise += item.paise;
      split.unattributedIds.push(item.id);
      continue;
    }

    /* An account that had already bought cannot be being ACQUIRED, whatever
       the purpose on the leg says — a salesman ticking "new customer" against
       a shop we invoiced last March does not make March go away. The purpose
       is what the salesman meant; the order history is what happened, and
       where they disagree the history wins. */
    if (item.customerHadOrderedBefore === false) {
      split.acquisitionPaise += item.paise;
      split.acquisitionIds.push(item.id);
    } else {
      split.servicingPaise += item.paise;
      split.servicingIds.push(item.id);
    }
  }
  return split;
}

export type Coca = {
  costPaise: number;
  newCustomers: number;
  /** Paise per customer won. Null where nobody was won. */
  perCustomerPaise: number | null;
  reason: string | null;
};

/**
 * Requirement 62 — what a new customer cost.
 *
 * Zero new customers is null with a reason, never zero and never infinity. A
 * month of prospecting that has not landed yet is a real and ordinary thing,
 * and "₹0 per customer" on that month is the opposite of what happened.
 */
export function coca(acquisitionPaise: number, newCustomers: number): Coca {
  if (newCustomers <= 0) {
    return {
      costPaise: acquisitionPaise,
      newCustomers: 0,
      perCustomerPaise: null,
      reason:
        acquisitionPaise > 0
          ? "Money was spent on winning customers and none has been won yet in this period, so there is no cost per customer to state."
          : "Nothing was spent on acquisition in this period.",
    };
  }
  return {
    costPaise: acquisitionPaise,
    newCustomers,
    perCustomerPaise: Math.round(acquisitionPaise / newCustomers),
    reason: null,
  };
}

export type ServicingCost = {
  costPaise: number;
  customersServed: number;
  perCustomerPaise: number | null;
  reason: string | null;
};

/** Requirement 63. Kept in its own function so it can never be added to COCA. */
export function servicingCost(servicingPaise: number, customersServed: number): ServicingCost {
  if (customersServed <= 0) {
    return {
      costPaise: servicingPaise,
      customersServed: 0,
      perCustomerPaise: null,
      reason: "No existing customer was visited in this period.",
    };
  }
  return {
    costPaise: servicingPaise,
    customersServed,
    perCustomerPaise: Math.round(servicingPaise / customersServed),
    reason: null,
  };
}

/**
 * Requirement 64 — one customer against what it costs to keep them.
 *
 * Acquisition and servicing are both subtracted here, which is the only place
 * they are ever added together — and they are added as two named numbers
 * rather than as one "customer cost", so the screen can still show which is
 * which. Requirement 65 is about not MIXING them; it is not about pretending a
 * customer only costs one of them.
 */
export function customerReturn(
  revenuePaise: number,
  acquisitionPaise: number,
  servicingPaise: number,
  marginBps?: number | null,
): ReturnFigure & { acquisitionPaise: number; servicingPaise: number } {
  const hasMargin = typeof marginBps === "number" && marginBps > 0;
  const returned = hasMargin ? Math.round((revenuePaise * marginBps!) / 10_000) : revenuePaise;
  const cost = acquisitionPaise + servicingPaise;
  return {
    basis: hasMargin ? "contribution" : "revenue",
    returnedPaise: returned,
    costPaise: cost,
    acquisitionPaise,
    servicingPaise,
    multiple: cost > 0 ? returned / cost : null,
    netPaise: returned - cost,
    caveat: hasMargin
      ? null
      : "Revenue against cost, not profit against cost — MahekOne holds no product costs.",
  };
}

/* ------------------------------------------------------------ §M rankings */

export type RankedSalesman = SalesmanPeriod & {
  cost: CostBreakdown;
  perKm: Ratio;
  perVisit: Ratio;
  expenseRatioBps: Ratio;
  ret: ReturnFigure;
};

export function rank(people: readonly SalesmanPeriod[], marginBps?: number | null): RankedSalesman[] {
  return people.map((p) => {
    const cost = totalSalesmanCost(p);
    return {
      ...p,
      cost,
      perKm: salesPerKm(p),
      perVisit: salesPerVisit(p),
      expenseRatioBps: travelExpenseRatioBps(p),
      ret: salesmanReturn(p, cost, marginBps),
    };
  });
}

/**
 * Requirement 70 — the best and the worst, on a stated measure.
 *
 * People whose figure could not be worked out are returned separately rather
 * than sorted to the bottom. Somebody with no kilometres recorded is not the
 * worst performer on sales-per-kilometre; they are a person the question
 * cannot be asked of, and putting them at the bottom of a league table is an
 * accusation made out of missing data.
 */
export function topAndBottom(
  people: readonly RankedSalesman[],
  measure: (p: RankedSalesman) => number | null,
  count = 3,
): { top: RankedSalesman[]; bottom: RankedSalesman[]; unmeasurable: RankedSalesman[] } {
  const measurable: { p: RankedSalesman; v: number }[] = [];
  const unmeasurable: RankedSalesman[] = [];
  for (const p of people) {
    const v = measure(p);
    if (v === null || !Number.isFinite(v)) unmeasurable.push(p);
    else measurable.push({ p, v });
  }
  measurable.sort((a, b) => b.v - a.v);
  return {
    top: measurable.slice(0, count).map((x) => x.p),
    bottom: measurable.slice(-count).reverse().map((x) => x.p),
    unmeasurable,
  };
}
