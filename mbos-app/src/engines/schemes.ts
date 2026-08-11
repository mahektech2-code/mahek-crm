/**
 * Schemes — the discounts and free-quantity offers that ride on an order.
 *
 * **Eligibility is data, not code.** Every scheme is a declarative predicate
 * evaluated against facts about the line and the order, so a new offer is a row
 * that syncs down to the handset, not a release. That matters more here than it
 * looks: schemes in this trade change monthly, they are decided by people with
 * no access to a build pipeline, and a salesman on a 2G connection in a market
 * cannot be told "update the app first". Anything that would need an `if` in
 * this file is a scheme that cannot be run offline against cached definitions,
 * which is the same as a scheme that does not exist.
 *
 * Everything below runs against whatever definitions the device already has.
 * No I/O, no clock — a scheme's validity window is decided by the caller when
 * it hands over the list, because "is today inside the window" is a question
 * about the clock and the clock is not this file's business.
 */

/* --------------------------------------------------------------- predicate */

export type FactValue = string | number | boolean | null;
export type Facts = Record<string, FactValue>;

/**
 * The predicate language. Deliberately small: five comparisons and three
 * combinators. Anything a scheme cannot say in this vocabulary is a
 * conversation about the vocabulary, not a special case bolted onto a screen.
 */
export type Predicate =
  | { field: string; op: 'eq' | 'neq'; value: FactValue }
  | { field: string; op: 'gte' | 'lte' | 'gt' | 'lt'; value: number }
  | { field: string; op: 'in' | 'not_in'; value: FactValue[] }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

export function matches(predicate: Predicate, facts: Facts): boolean {
  if ('all' in predicate) return predicate.all.every((p) => matches(p, facts));
  if ('any' in predicate) return predicate.any.some((p) => matches(p, facts));
  if ('not' in predicate) return !matches(predicate.not, facts);

  const actual = facts[predicate.field] ?? null;
  switch (predicate.op) {
    case 'eq':
      return actual === predicate.value;
    case 'neq':
      return actual !== predicate.value;
    case 'in':
      return predicate.value.includes(actual);
    case 'not_in':
      return !predicate.value.includes(actual);
    // A missing or non-numeric fact fails a numeric comparison rather than
    // being coerced. `null >= 10` is false in JavaScript and true-ish in
    // enough other places that leaving it to coercion is how a scheme quietly
    // applies to everybody.
    case 'gte':
      return typeof actual === 'number' && actual >= predicate.value;
    case 'lte':
      return typeof actual === 'number' && actual <= predicate.value;
    case 'gt':
      return typeof actual === 'number' && actual > predicate.value;
    case 'lt':
      return typeof actual === 'number' && actual < predicate.value;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ scheme */

export type SchemeBenefit =
  | { kind: 'percent_discount'; percent: number }
  | { kind: 'flat_discount'; amountPaise: number }
  /** Buy `perCans`, get `freeCans` of the same SKU. The commonest offer here. */
  | { kind: 'free_quantity'; perCans: number; freeCans: number };

export type Scheme = {
  id: string;
  name: string;
  /** `line` is judged per order line; `order` against the order as a whole. */
  level: 'line' | 'order';
  when: Predicate;
  benefit: SchemeBenefit;
  /** Higher wins where two schemes are both eligible and neither stacks. */
  priority: number;
  /**
   * False means "this and nothing else on the same line". Two non-stacking
   * schemes on one line is the case that produces an invoice the office has to
   * unpick by hand, so the engine picks one by priority rather than adding both.
   */
  stackable: boolean;
};

export type OrderLine = {
  skuId: string;
  cans: number;
  /**
   * Null where the price source is unset — see `order.ts`. A percentage of an
   * unknown value is not zero, and the line says so rather than showing a
   * confident ₹0 discount.
   */
  valuePaise: number | null;
  /** Anything a scheme might key on: brand, formulation, pack size, category. */
  attributes?: Facts;
};

export type AppliedScheme = {
  schemeId: string;
  name: string;
  discountPaise: number | null;
  freeCans: number;
  sentence: string;
};

export type SchemedLine = {
  line: OrderLine;
  applied: AppliedScheme[];
  /** Null when at least one eligible scheme could not be valued. */
  discountPaise: number | null;
  freeCans: number;
};

export type SchemeResult = {
  lines: SchemedLine[];
  orderSchemes: AppliedScheme[];
  /** Null when anything in the order could not be valued. */
  totalDiscountPaise: number | null;
  totalFreeCans: number;
};

/**
 * Apply the cached scheme definitions to an order.
 *
 * `customerCategory` is lifted into the facts for every line, because almost
 * every scheme in this business is written as "dealers get X" or "this applies
 * to the retail slab" and asking each caller to remember to include it is how
 * one screen offers a dealer discount to a retailer.
 */
export function applySchemes(
  lines: readonly OrderLine[],
  customerCategory: string | null,
  schemes: readonly Scheme[],
): SchemeResult {
  const orderCans = lines.reduce((sum, l) => sum + l.cans, 0);
  const valued = lines.every((l) => l.valuePaise != null);
  const orderValuePaise = valued
    ? lines.reduce((sum, l) => sum + (l.valuePaise ?? 0), 0)
    : null;

  const lineSchemes = schemes.filter((s) => s.level === 'line');
  const outLines: SchemedLine[] = lines.map((line) => {
    const facts: Facts = {
      ...(line.attributes ?? {}),
      skuId: line.skuId,
      cans: line.cans,
      valuePaise: line.valuePaise,
      customerCategory,
      orderCans,
      orderValuePaise,
    };
    const eligible = pick(lineSchemes, facts);
    const applied = eligible.map((s) => benefitFor(s, line.valuePaise, line.cans));
    return {
      line,
      applied,
      discountPaise: sumOrNull(applied.map((a) => a.discountPaise)),
      freeCans: applied.reduce((sum, a) => sum + a.freeCans, 0),
    };
  });

  const orderFacts: Facts = {
    customerCategory,
    orderCans,
    orderValuePaise,
    lineCount: lines.length,
  };
  const orderSchemes = pick(schemes.filter((s) => s.level === 'order'), orderFacts).map((s) =>
    benefitFor(s, orderValuePaise, orderCans),
  );

  return {
    lines: outLines,
    orderSchemes,
    totalDiscountPaise: sumOrNull([
      ...outLines.map((l) => l.discountPaise),
      ...orderSchemes.map((s) => s.discountPaise),
    ]),
    totalFreeCans:
      outLines.reduce((sum, l) => sum + l.freeCans, 0) +
      orderSchemes.reduce((sum, s) => sum + s.freeCans, 0),
  };
}

/**
 * The eligible set, resolved for stacking.
 *
 * Highest priority decides, and then its own stackability decides everything
 * else: a non-stacking winner applies **alone**, which is what "and nothing
 * else on this line" has to mean if it is to be worth declaring. Letting the
 * lesser schemes ride along underneath it would make the flag decorative, and
 * the invoice would be the place anybody found out.
 */
function pick(schemes: readonly Scheme[], facts: Facts): Scheme[] {
  const eligible = schemes
    .filter((s) => matches(s.when, facts))
    .sort((a, b) => b.priority - a.priority);
  if (eligible.length <= 1) return eligible;

  const top = eligible[0]!;
  if (!top.stackable) return [top];
  // The winner stacks, so everything else that stacks joins it. The exclusive
  // ones that lost drop out entirely rather than being folded in.
  return eligible.filter((s) => s.stackable);
}

function benefitFor(scheme: Scheme, valuePaise: number | null, cans: number): AppliedScheme {
  switch (scheme.benefit.kind) {
    case 'percent_discount': {
      const pct = scheme.benefit.percent;
      const discount = valuePaise == null ? null : Math.round((valuePaise * pct) / 100);
      return {
        schemeId: scheme.id,
        name: scheme.name,
        discountPaise: discount,
        freeCans: 0,
        sentence:
          discount == null
            ? `${scheme.name} — ${pct}% off, worth working out once this line has a price.`
            : `${scheme.name} — ${pct}% off.`,
      };
    }
    case 'flat_discount':
      return {
        schemeId: scheme.id,
        name: scheme.name,
        discountPaise: scheme.benefit.amountPaise,
        freeCans: 0,
        sentence: `${scheme.name} — flat discount.`,
      };
    case 'free_quantity': {
      const { perCans, freeCans } = scheme.benefit;
      // Whole sets only. Half a free can is not a thing that can be dispatched.
      const sets = perCans > 0 ? Math.floor(cans / perCans) : 0;
      const free = sets * freeCans;
      return {
        schemeId: scheme.id,
        name: scheme.name,
        discountPaise: 0,
        freeCans: free,
        sentence:
          free > 0
            ? `${scheme.name} — ${free} free with ${cans}.`
            : `${scheme.name} — ${perCans} needed before the free ${freeCans} applies.`,
      };
    }
    default:
      return {
        schemeId: scheme.id,
        name: scheme.name,
        discountPaise: 0,
        freeCans: 0,
        sentence: scheme.name,
      };
  }
}

/** Null the moment any part is null — an unknown plus a number is unknown. */
function sumOrNull(values: (number | null)[]): number | null {
  if (values.some((v) => v == null)) return null;
  return values.reduce((sum: number, v) => sum + (v ?? 0), 0);
}
