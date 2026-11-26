import { all, getKv, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { whereNow } from '../native/where';
import { insertAndQueue, insertLocal, stamp, updateAndQueue } from './write';
import { getConfig } from './config';
import { assessOrder } from '../engines/credit';
import { canValueOrders, derivedQuantities, lineValuePaise, type PriceSource } from '../engines/order';
import { applySchemes, type Predicate, type Scheme } from '../engines/schemes';
import { istDayStartMs, todayIst } from '../lib/format';
import { priceKeyFor, ratesForTag } from './pricing';
import { officeCreditRefusal, minimumRefusal, overdueRefusal, type OfficeRefusal } from '../engines/order-gates';
import { OPEN_BILLS_FOR_GATES_SQL, ORDER_QUEUE_ROWS_SQL, UNSENT_CREATE_SQL, UNSENT_ORDERS_PAISE_SQL } from './order-money';

/**
 * Punching an order.
 *
 * Validation order is from the brief and it matters — the cheapest check first,
 * and the one blocking condition before the salesman is allowed to build a
 * cart at all. Letting somebody spend two minutes assembling twelve lines for
 * a credit-blocked customer and refusing at the end is the wrong shape.
 */

export type CartLine = {
  productId: string;
  productName: string;
  cans: number;
  cansPerBox: number | null;
  millilitresPerCan: number | null;
  sellingPricePaise: number | null;
  /** Typed by the salesman where the price source says the rate is manual. */
  typedRatePaise?: number | null;
};

export type OrderAssessment = {
  /**
   * WHOSE FIGURES THESE ARE.
   *
   * The two figures are the ones the verdict below was reached on, read off
   * the BILLING party. The order screen drew the SHOP's owing and the SHOP's
   * credit limit beside the biller's name instead — so an account served
   * through a distributor showed a comfortable bar over an assessment saying
   * the order needed approval, and "nothing owing" over a distributor already
   * past their limit. The id rides with them so a screen can tell an answer
   * about this biller from one still on screen about the last.
   */
  billingCustomerId: string;
  billingOutstandingPaise: number;
  billingCreditLimitPaise: number | null;
  canOrder: boolean;
  blockReason: string | null;
  /**
   * WHAT THE OFFICE WILL REFUSE AT SYNC, where it will — the limit with
   * `mbos.credit.blockOnLimitExceeded` on, a bill past
   * `mbos.credit.overdueDaysBlockOrders`, a line under
   * `mbos.orders.minimumQuantityCans`. Not a credit block: the cart stays
   * open so he can make the order smaller, and the button says why it will
   * not send. See `engines/order-gates.ts`.
   */
  officeRefusal: OfficeRefusal | null;
  valuePaise: number | null;
  valueUnavailable: boolean;
  decision: 'blocked' | 'ok' | 'needs_approval';
  reason: string;
  /* Null where the order could not be valued at all — an unvalued order is not
     an order that comfortably fits, and saying so is the whole point. */
  availablePaise: number | null;
  overByPaise: number;
  /**
   * The price list the lines were priced against, where they were — sent so
   * the office can tell a rate that moved since the phone last synced from a
   * rate the salesman invented. Null where nothing was priced off a list.
   */
  priceTag: string | null;
  /** What the phone believed the biller owed, and as of when — see the payload. */
  outstandingAsOfPaise: number;
  outstandingAsOf: number | null;
  lines: {
    line: CartLine;
    cans: number; boxes: number; looseCans: number; litres: number | null;
    /** The rate this line is worth per can, wherever it came from. */
    ratePaise: number | null;
    valuePaise: number | null;
    schemeNote: string | null;
  }[];
};

/**
 * Whether an order can be created at all.
 *
 * A credit-blocked customer is the ONLY outright block in this app. Everything
 * else — over the limit, over the approval threshold — flags or routes to
 * approval, and the order still saves.
 *
 * THE ID IS THE BILLING PARTY, always. On a shop served through a distributor
 * the goods and the invoice go to different accounts, and the limit, the
 * outstanding and the block belong to whoever is invoiced — the shop's own
 * credit says nothing about whether we can afford to sell to the distributor,
 * and on a purely third-party shop there is no limit recorded at all. Passing
 * the delivery party here would assess an order against a blank account and
 * wave everything through.
 */
/**
 * A stored scheme row, into the shape `applySchemes` actually reads.
 *
 * The server table has exactly two JSON columns — `eligibility` and
 * `benefit` — and the engine wants five fields (`level`, `when`, `benefit`,
 * `priority`, `stackable`). `benefit` maps straight across; the other four
 * live inside `eligibility`, which is `{ level?, priority?, stackable?,
 * when }`. This used to spread both columns flat onto one object instead of
 * nesting them, so `when` was always `undefined` and `matches()` would throw
 * the first time a real scheme existed to test it against — dormant only
 * because `mbos_schemes` had always been empty.
 *
 * A scheme with no `when` at all fails CLOSED (`{ any: [] }`, never
 * eligible) rather than open — an empty predicate reading as "matches
 * everything" would hand out a discount nobody asked for the moment
 * somebody left the field blank.
 */
function parseScheme(row: { id: string; name: string; eligibility: string; benefit: string }): Scheme {
  const elig = JSON.parse(row.eligibility) as {
    level?: 'line' | 'order';
    priority?: number;
    stackable?: boolean;
    when?: Predicate;
  };
  return {
    id: row.id,
    name: row.name,
    level: elig.level ?? 'line',
    priority: elig.priority ?? 0,
    stackable: elig.stackable ?? false,
    when: elig.when ?? { any: [] },
    benefit: JSON.parse(row.benefit),
  };
}

export async function assessCart(
  billingCustomerId: string,
  lines: CartLine[],
  opts: {
    /** The order being edited: left out of what is already ordered, and its old value is what the office compares against. */
    editingOrderId?: string | null;
    /** A change request after approval: the office re-checks only the lines (`checkOrderLines`), never the credit. */
    changeRequest?: boolean;
  } = {},
): Promise<OrderAssessment> {
  const customer = await one<{
    name: string;
    creditBlocked: number; creditBlockReason: string | null;
    creditLimitPaise: number | null; outstandingPaise: number; submittedNotInvoicedPaise: number;
    customerType: string | null; priceTag: string | null;
  }>('SELECT * FROM customers WHERE id = ?', [billingCustomerId]);
  /* Ordered and not yet billed: the office's figure, plus what this phone has
     taken that the office has not heard about — see `data/order-money.ts`. */
  const unsent = await one<{ paise: number }>(UNSENT_ORDERS_PAISE_SQL, [billingCustomerId, opts.editingOrderId ?? '']);
  const editing = opts.editingOrderId
    ? await one<{ netTotalPaise: number | null }>('SELECT netTotalPaise FROM orders WHERE id = ?', [opts.editingOrderId])
    : null;

  const priceSource = await getConfig<PriceSource>('products.priceSource', 'unset');
  const approvalThreshold = await getConfig<number>('mbos.orders.approvalThresholdPaise', 0);
  const secondTier = await getConfig<number>('mbos.orders.secondTierThresholdPaise', 0);

  const schemes = await all<{ id: string; name: string; eligibility: string; benefit: string }>(
    'SELECT * FROM schemes WHERE active = 1',
  );

  /*
   * THE BILLER'S OWN PRICE LIST, where that is the source the office chose.
   *
   * `lineValuePaise`'s `pricelist` branch takes the figure as typed, because
   * the engine is ported from MahekOne and looks nothing up — and nothing on
   * this screen ever typed one, so every order went up valued at ₹0 beside a
   * real "List value" the same screen had just drawn from the same rates. The
   * rate is looked up HERE, off the BILLER's tag — a shop served through a
   * distributor pays what the distributor's list says — and handed to the
   * engine as the line's figure, which is exactly what the server's half of
   * the rule expects to be told.
   */
  const priceTag = priceSource === 'pricelist' ? customer?.priceTag ?? null : null;
  /* The key the office's rates for THIS biller are filed under — the tag, or
     the tag and the list where shops on one tag sit on different lists. */
  const priceKey = priceSource === 'pricelist' ? await priceKeyFor(billingCustomerId, customer?.priceTag ?? null) : null;
  const listRates = priceKey ? await ratesForTag(priceKey) : new Map<string, number>();

  const priced = lines.map((line) => {
    const q = derivedQuantities(line.cans, line.cansPerBox ?? 1, line.millilitresPerCan ?? 0);
    const listRate = priceSource === 'pricelist' ? listRates.get(line.productId) ?? null : null;
    const ratePaise =
      priceSource === 'pricelist'
        ? listRate
        : priceSource === 'product'
          ? line.sellingPricePaise
          : priceSource === 'manual'
            ? line.typedRatePaise ?? null
            : null;
    const valuePaise = lineValuePaise(
      priceSource,
      line.cans,
      { sellingPricePaise: line.sellingPricePaise },
      priceSource === 'pricelist'
        ? listRate == null ? null : line.cans * listRate
        : priceSource === 'manual' && line.typedRatePaise != null
          ? line.cans * line.typedRatePaise
          : null,
    );
    return { line, ...q, ratePaise, valuePaise, schemeNote: null as string | null };
  });

  /* Only a SKU can be ordered, so the scheme engine keys on `skuId` — the same
     rule MahekOne's catalogue holds to. */
  const schemeResult = applySchemes(
    priced.map((p) => ({ skuId: p.line.productId, cans: p.cans, valuePaise: p.valuePaise })),
    customer?.customerType ?? null,
    schemes.map((s) => parseScheme(s)),
  );
  for (const schemed of schemeResult.lines) {
    const target = priced.find((p) => p.line.productId === schemed.line.skuId);
    if (target && schemed.applied.length) {
      target.schemeNote = schemed.applied.map((a) => a.name).join(', ');
    }
  }

  /* Until a price source is confirmed there is no honest way to value an
     order, and a confident zero on a target screen is worse than a blank. */
  const valuable = canValueOrders(priceSource);
  const valuePaise = valuable && priced.every((p) => p.valuePaise != null)
    ? priced.reduce((a, p) => a + (p.valuePaise ?? 0), 0) - (schemeResult.totalDiscountPaise ?? 0)
    : null;

  const verdict = assessOrder({
    creditBlocked: !!customer?.creditBlocked,
    creditLimitPaise: customer?.creditLimitPaise ?? null,
    outstandingPaise: customer?.outstandingPaise ?? 0,
    submittedPaise: Math.max(0, customer?.submittedNotInvoicedPaise ?? 0) + (unsent?.paise ?? 0),
    orderValuePaise: valuePaise,
    approvalThresholdPaise: approvalThreshold,
    secondTierThresholdPaise: secondTier,
  });

  const billerName = customer?.name ?? 'This customer';
  const [blockOnLimit, overdueDays, minimumCans] = await Promise.all([
    getConfig<boolean>('mbos.credit.blockOnLimitExceeded', true),
    getConfig<number>('mbos.credit.overdueDaysBlockOrders', 0),
    getConfig<number>('mbos.orders.minimumQuantityCans', 0),
  ]);
  const openBills = !opts.editingOrderId && !opts.changeRequest && overdueDays > 0
    ? await all<{ billNo: string | null; dueDate: string | null; balancePaise: number | null; paymentPosition: string | null; disputed: number | null }>(
        OPEN_BILLS_FOR_GATES_SQL,
        [billingCustomerId],
      )
    : [];
  const officeRefusal =
    minimumRefusal({ minimumCans, lines: lines.map((l) => ({ productName: l.productName, cans: l.cans })) }) ??
    /* A new order only — the office checks an edit against the limit, never
       against the overdue rule. */
    (opts.editingOrderId || opts.changeRequest ? null : overdueRefusal({ blockDays: overdueDays, billerName, bills: openBills, today: todayIst() })) ??
    (opts.changeRequest ? null : officeCreditRefusal({
      blockOnLimitExceeded: blockOnLimit,
      billerName,
      creditLimitPaise: customer?.creditLimitPaise ?? null,
      outstandingPaise: customer?.outstandingPaise ?? 0,
      orderValuePaise: valuePaise,
      previousValuePaise: opts.editingOrderId ? editing?.netTotalPaise ?? 0 : null,
    }));

  return {
    officeRefusal,
    /* The same three the verdict was reached on, handed back so the screen
       draws the biller's credit rather than the shop's. */
    billingCustomerId,
    billingOutstandingPaise: customer?.outstandingPaise ?? 0,
    billingCreditLimitPaise: customer?.creditLimitPaise ?? null,
    canOrder: verdict.decision !== 'blocked',
    blockReason: verdict.decision === 'blocked' ? (customer?.creditBlockReason ?? verdict.reason) : null,
    valuePaise,
    valueUnavailable: !valuable || valuePaise === null,
    decision: verdict.decision,
    reason: verdict.reason,
    availablePaise: verdict.availablePaise,
    overByPaise: verdict.overByPaise,
    priceTag: priced.some((p) => p.ratePaise != null) ? priceTag : null,
    outstandingAsOfPaise: customer?.outstandingPaise ?? 0,
    outstandingAsOf: Number((await getKv('lastPullAt')) ?? 0) || null,
    lines: priced,
  };
}

/**
 * Save the order.
 *
 * The order number is NOT generated here. It comes from a configured series on
 * the server on first successful sync — two salesmen offline must never mint
 * the same one, which is precisely why the number is not the identity. Until
 * it arrives the screen shows the client reference and says so.
 */
export async function saveOrder(args: {
  /**
   * Who we INVOICE. Every figure is read from this one — the credit
   * assessment, the outstanding it adds to, the term, and the account the
   * order belongs to commercially.
   */
  customerId: string;
  customerName: string;
  /**
   * Where the goods GO, when that is not where the bill goes.
   *
   * Undefined or the billing party's own id both mean "they received them
   * themselves": the two spellings are folded to null before anything is
   * stored, or one arrangement reaches the column two ways and every read has
   * to know both.
   */
  deliveryCustomerId?: string | null;
  deliveryCustomerName?: string | null;
  userId: string;
  visitId?: string | null;
  lines: CartLine[];
  assessment: OrderAssessment;
  paymentTermDays?: number | null;
  /**
   * What he answered the duplicate warning, where the phone could ask it:
   * "Different order - create it", the TO it looked like, and why. The TO
   * carries it for Accounts. Absent offline, where the office checks at sync.
   */
  duplicate?: { decision: 'different'; ofId: string; reason: string } | null;
}): Promise<{ orderId: string; needsApproval: boolean }> {
  const base = await stamp('order');
  const needsApproval = args.assessment.decision === 'needs_approval';
  const deliveryId =
    args.deliveryCustomerId && args.deliveryCustomerId !== args.customerId
      ? args.deliveryCustomerId
      : null;

  const where = await whereNow().catch(() => undefined);
  await tx(async () => {
    await run(
      `INSERT INTO orders (id, customerId, deliveryCustomerId, userId, visitId, orderedAt, status, paymentTermDays,
                           netTotalPaise, valueUnavailable, clientCreatedAt, deviceId, syncState)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued')`,
      [
        base.id, args.customerId, deliveryId, args.userId, args.visitId ?? null, Date.now(),
        needsApproval ? 'pending_approval' : 'submitted',
        args.paymentTermDays ?? null,
        args.assessment.valuePaise, args.assessment.valueUnavailable ? 1 : 0,
        base.clientCreatedAt, base.deviceId,
      ],
    );

    for (const p of args.assessment.lines) {
      await run(
        `INSERT INTO order_lines (id, orderId, productId, productName, cans, boxes, litres, ratePaise, schemeApplied, lineTotalPaise)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [newId('line'), base.id, p.line.productId, p.line.productName, p.cans, p.boxes, p.litres,
         p.ratePaise, p.schemeNote, p.valuePaise],
      );
    }

    /* The approval request is a record of its own, and the order's state is
       DERIVED from it — nothing sets a flag on the order independently. */
    if (needsApproval) {
      const { raiseApproval } = await import('./requests');
      const approvalId = await raiseApproval({
        type: args.assessment.overByPaise > 0 ? 'order_over_credit' : 'order_over_threshold',
        subjectType: 'order',
        subjectId: base.id,
        reason: args.assessment.reason,
        deviceId: base.deviceId,
        /* This save's transaction is open; `tx()` does not nest. */
        inTransaction: true,
      });
      await run('UPDATE orders SET approvalId = ? WHERE id = ?', [approvalId, base.id]);
    }

    /*
     * The event goes where the salesman was STANDING.
     *
     * He opens a shop's screen and wants to see that an order was taken there;
     * filing it only against the distributor leaves that shop's history empty
     * on the day he served it. The order's commercial home is the order row,
     * which names the biller — this is a record of activity at a place.
     */
    await insertLocal('timeline_events', {
      id: newId('tl'),
      customerId: deliveryId ?? args.customerId,
      eventType: 'order',
      sourceApp: 'mbos',
      sourceRecordId: base.id,
      occurredAt: Date.now(),
      actor: 'You',
      summary: `${args.assessment.lines.length} line order`,
    });

    /* `lastOrderDate` moves on capture, not on approval — it is the signal
       that stops the queue chasing somebody who ordered this morning, and a
       slow approval must not cause a second ring. */
    /* `submittedNotInvoicedPaise` is NOT moved: it is the office's figure,
       and an order still in the outbox is added to it where it is read
       (`UNSENT_ORDERS_PAISE_SQL`), so it counts once and stops counting when
       it is billed, declined or refused. */
    await run('UPDATE customers SET lastOrderDate = ? WHERE id = ?', [todayIst(), args.customerId]);

    /* The shop it was DELIVERED to stops being chased too — being served is
       being served, whoever was invoiced. Only the DATE moves: the money is
       the biller's and `submittedNotInvoicedPaise` stays with them. */
    if (deliveryId) {
      await run('UPDATE customers SET lastOrderDate = ? WHERE id = ?', [
        todayIst(),
        deliveryId,
      ]);
    }
    /* IN THE SAME TRANSACTION AS THE ROW — see `insertAndQueue` in
       `write.ts`. The location was read before the transaction opened. */
    await enqueue({
      where,
      entityType: 'order',
      entityId: base.id,
      op: 'create',
      /* Behind the shops it names, where either was added on this phone and has
         not reached the office yet — see the same line in `visits.ts`. A shop
         with nothing in the outbox counts as landed, so an order for a shop the
         office already has goes exactly as before. */
      dependsOn: [...new Set([args.customerId, ...(deliveryId ? [deliveryId] : [])])],
      /* The WIRE names, which are not this table's column names — see
         PROTOCOL.md §4.1. `cans` is what a telecaller counts and what this app
         stores; `quantityCans` is what MahekOne calls the same number, and the
         payload is MahekOne's vocabulary rather than ours. Sending our own put
         every field order on the rejections screen with a validation message
         about a field nobody on either end had typed. */
      payload: {
        id: base.id,
        customerId: args.customerId,
        /* Not read by the server. Kept so a refusal can name the shop on the
           handset, which is the screen the salesman is actually looking at. */
        customerName: args.customerName,
        /* Null where the biller received them. The server folds its own copy of
           this rule too, because a payload is not a place to trust. */
        deliveryCustomerId: deliveryId ?? undefined,
        visitId: args.visitId ?? undefined,
        orderedAt: base.clientCreatedAt,
        totalAmountPaise: args.assessment.valuePaise ?? 0,
        valueUnavailable: args.assessment.valueUnavailable,
        creditDays: args.paymentTermDays ?? undefined,
        /* What the phone priced and believed, so the office can say "the rate
           moved" or "the balance moved under you" rather than a bare refusal —
           two different conversations with two different people. */
        priceTag: args.assessment.priceTag ?? undefined,
        outstandingAsOfPaise: args.assessment.outstandingAsOfPaise,
        outstandingAsOf: args.assessment.outstandingAsOf ?? undefined,
        lines: args.assessment.lines.map((p) => ({
          productId: p.line.productId,
          quantityCans: p.cans,
          ratePaise: p.ratePaise ?? undefined,
        })),
        duplicate: args.duplicate ?? undefined,
        deviceId: base.deviceId,
        clientCreatedAt: base.clientCreatedAt,
      },
      /* NOT behind the visit. The visit's id is minted at the door and the
         visit itself is saved at check-out — or never, if the trip is called
         off — so waiting on it held a customer's order in the outbox for the
         length of the visit at best and for ever at worst. */
    });
  });

  return { orderId: base.id, needsApproval };
}

/**
 * What was sold today, from this handset.
 *
 * `valueUnavailable` is carried rather than folded into a zero: until a price
 * source is confirmed an order is worth what the salesman typed, and a
 * confident ₹0 on the home screen is worse than a blank.
 *
 * ONLY ORDERS THAT ARE STILL ORDERS. It counted everything but `cancelled`,
 * so an order accounts declined and one the office refused at sync both went
 * on reading as sold today — on the home screen, where he judges his day.
 */
export async function ordersToday(userId: string, from = startOfToday()): Promise<{
  count: number;
  valuePaise: number;
  valueUnavailable: boolean;
}> {
  const row = await one<{ n: number; total: number; unknown: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(netTotalPaise), 0) AS total,
            SUM(CASE WHEN valueUnavailable = 1 OR netTotalPaise IS NULL THEN 1 ELSE 0 END) AS unknown
       FROM orders
      WHERE userId = ? AND orderedAt >= ?
        AND status IN ('submitted','pending_approval','approved','dispatched','in_transit','delivered')
        AND COALESCE(syncState, '') NOT IN ('rejected','blocked')`,
    [userId, from],
  );
  return {
    count: row?.n ?? 0,
    valuePaise: row?.total ?? 0,
    valueUnavailable: (row?.unknown ?? 0) > 0,
  };
}

/* The office's day, not the phone's: see `istDayStartMs`. */
function startOfToday(): number {
  return istDayStartMs();
}

/* --------------------------------------------------- what he has punched */

export type PunchedOrder = {
  id: string;
  customerId: string;
  customerName: string | null;
  orderNumber: string | null;
  orderedAt: number;
  deliveryDate: string | null;
  status: string;
  netTotalPaise: number | null;
  valueUnavailable: number;
  cancelReason: string | null;
  syncState: string;
  syncMessage: string | null;
  /* The Order Hub's reading, from the office; null until it has sent one. */
  toNo: number | null;
  erpOrderNo: number | null;
  journeyStatus: string | null;
  journeyTone: string | null;
  journeyBanner: string | null;
  journeyEditable: number | null;
  journeySteps: string | null;
  /** `lib/order-journey.ts`'s JourneyState, Accounts' words, and the TO it may duplicate. */
  journeyState: string | null;
  journeyReason: string | null;
  duplicateOfToNo: number | null;
};

/** One rung of the ladder the office sent (`lib/order-journey.ts`). */
export type JourneyStep = { key: string; label: string; state: 'done' | 'current' | 'hold' | 'todo'; at: string | null; note?: string; backOffice?: boolean; production?: boolean };

export function journeyStepsOf(o: Pick<PunchedOrder, 'journeySteps'>): JourneyStep[] {
  if (!o.journeySteps) return [];
  try {
    const v = JSON.parse(o.journeySteps) as unknown;
    return Array.isArray(v) ? (v as JourneyStep[]) : [];
  } catch {
    return [];
  }
}

/** "TO-1043" until the order number exists, then "Order 5819"; null where the office has said neither. */
export function orderTitle(o: Pick<PunchedOrder, 'toNo' | 'erpOrderNo'>): string | null {
  if (o.erpOrderNo != null) return `Order ${o.erpOrderNo}`;
  if (o.toNo != null) return `TO-${o.toNo}`;
  return null;
}

/**
 * The orders he has taken, newest first.
 *
 * HIS record, like `listPayments` beside it, and not the office's: the
 * customer record's Orders tab reads `customer_orders`, which is what the
 * office has accepted and billed. This reads `orders` — what he punched,
 * including the one still sitting in the outbox because he was in a basement.
 * A salesman who cannot see what he took this morning has no way to answer
 * "did that go through?" except by asking somebody at a desk.
 *
 * The customer's NAME is joined rather than left to the caller, for the same
 * reason every other list here joins it: a list of amounts cannot be worked.
 */
export async function listOrders(customerId?: string): Promise<PunchedOrder[]> {
  const select = `SELECT o.id, o.customerId, c.name AS customerName, o.orderNumber, o.orderedAt,
                         o.deliveryDate, o.status, o.netTotalPaise, o.valueUnavailable,
                         o.cancelReason, o.syncState, o.syncMessage,
                         o.toNo, o.erpOrderNo, o.journeyStatus, o.journeyTone, o.journeyBanner,
                         o.journeyEditable, o.journeySteps, o.journeyState, o.journeyReason, o.duplicateOfToNo
                    FROM orders o LEFT JOIN customers c ON c.id = o.customerId`;
  return customerId
    ? all<PunchedOrder>(
        `${select} WHERE o.customerId = ? ORDER BY o.orderedAt DESC LIMIT 100`,
        [customerId],
      )
    : all<PunchedOrder>(`${select} ORDER BY o.orderedAt DESC LIMIT 100`);
}

/** One of his orders, with the shop's town — the receipt after sending it and the order's own page. */
export async function orderById(id: string): Promise<(PunchedOrder & { customerCity: string | null; lineCount: number }) | null> {
  return one<PunchedOrder & { customerCity: string | null; lineCount: number }>(
    `SELECT o.id, o.customerId, c.name AS customerName, c.city AS customerCity, o.orderNumber, o.orderedAt,
            o.deliveryDate, o.status, o.netTotalPaise, o.valueUnavailable,
            o.cancelReason, o.syncState, o.syncMessage,
            o.toNo, o.erpOrderNo, o.journeyStatus, o.journeyTone, o.journeyBanner,
            o.journeyEditable, o.journeySteps,
            (SELECT COUNT(*) FROM order_lines ol WHERE ol.orderId = o.id) AS lineCount
       FROM orders o LEFT JOIN customers c ON c.id = o.customerId
      WHERE o.id = ?`,
    [id],
  );
}

/** The orders he took today, newest first — "My orders today" under the receipt. */
export async function ordersTakenToday(): Promise<PunchedOrder[]> {
  const start = istDayStartMs();
  return all<PunchedOrder>(
    `SELECT o.id, o.customerId, c.name AS customerName, o.orderNumber, o.orderedAt,
            o.deliveryDate, o.status, o.netTotalPaise, o.valueUnavailable,
            o.cancelReason, o.syncState, o.syncMessage,
            o.toNo, o.erpOrderNo, o.journeyStatus, o.journeyTone, o.journeyBanner,
            o.journeyEditable, o.journeySteps
       FROM orders o LEFT JOIN customers c ON c.id = o.customerId
      WHERE o.orderedAt >= ? ORDER BY o.orderedAt DESC LIMIT 20`,
    [start],
  );
}

export type PunchedLine = {
  id: string;
  productName: string;
  /** The SKU code, off the catalogue on the phone. */
  sku: string | null;
  cans: number;
  litres: number | null;
  lineTotalPaise: number | null;
};

/** What was on it. Opened a row at a time, so the list itself stays cheap. */
export async function orderLines(orderId: string): Promise<PunchedLine[]> {
  return all<PunchedLine>(
    `SELECT ol.id, ol.productName, p.sku, ol.cans, ol.litres, ol.lineTotalPaise
       FROM order_lines ol LEFT JOIN products p ON p.id = ol.productId
      WHERE ol.orderId = ?`,
    [orderId],
  );
}

/* ------------------------------------------------------ changing an order */

/**
 * What a change has to wait behind: the order's own create, while it is still
 * in the outbox. Once the order has synced there is nothing to wait for — and
 * naming it anyway would hold the change for ever once that queue row is pruned.
 */
async function waitBehindOrder(orderId: string): Promise<string[]> {
  const row = await one<{ syncState: string }>('SELECT syncState FROM orders WHERE id = ?', [orderId]);
  return row && row.syncState !== 'synced' ? [orderId] : [];
}


/** Whether he may still edit it himself: until accounts decide it, and no further. */
export function editableStatus(status: string): boolean {
  return status === 'submitted' || status === 'pending_approval';
}

/** The order and its lines, to put back in the cart for an edit or a change. */
export async function orderForChange(orderId: string): Promise<{
  id: string;
  customerId: string;
  deliveryCustomerId: string | null;
  orderNumber: string | null;
  status: string;
  /** EVERY line, including one with no product id — the screen says which cannot carry over. */
  lines: { productId: string; productName: string; cans: number }[];
} | null> {
  const order = await one<{
    id: string; customerId: string; deliveryCustomerId: string | null; orderNumber: string | null; status: string;
  }>('SELECT id, customerId, deliveryCustomerId, orderNumber, status FROM orders WHERE id = ?', [orderId]);
  if (!order) return null;
  const lines = await all<{ productId: string; productName: string; cans: number }>(
    'SELECT productId, productName, cans FROM order_lines WHERE orderId = ?',
    [orderId],
  );
  return { ...order, lines };
}

/**
 * THE REFUSED ORDER, read back off the outbox to take it again.
 *
 * "Take the order again" used to let the refused entry go FIRST and open an
 * empty form on the BILLER — the distributor, on a third-party shop — so the
 * lines were gone before he had written a single one again, and the order
 * opened on the wrong shop. This reads what was refused, so the form opens on
 * the shop the goods were for, with the biller chosen and the lines in the
 * cart; the refused entry goes only once the new order is saved
 * (`finishRetake`).
 */
export async function refusedOrder(queueId: string): Promise<{
  queueId: string;
  customerId: string;
  deliveryCustomerId: string | null;
  lines: { productId: string; productName: string; cans: number }[];
} | null> {
  const item = await one<{ id: string; entityId: string; payload: string; state: string; op: string; entityType: string }>(
    'SELECT id, entityId, payload, state, op, entityType FROM sync_queue WHERE id = ?',
    [queueId],
  );
  if (!item || item.entityType !== 'order' || item.op !== 'create') return null;
  let p: { customerId?: string; deliveryCustomerId?: string | null; lines?: { productId?: string; quantityCans?: number }[] };
  try {
    p = JSON.parse(item.payload);
  } catch {
    return null;
  }
  if (!p.customerId) return null;
  /* The names from the order's own lines where the phone still has them — a
     product retired since is still named when the screen says it cannot come. */
  const named = await all<{ productId: string; productName: string }>(
    'SELECT productId, productName FROM order_lines WHERE orderId = ?',
    [item.entityId],
  );
  const nameOf = new Map(named.map((l) => [l.productId, l.productName]));
  return {
    queueId: item.id,
    customerId: p.customerId,
    deliveryCustomerId: p.deliveryCustomerId ?? null,
    lines: (p.lines ?? [])
      .filter((l) => typeof l.quantityCans === 'number')
      .map((l) => ({ productId: l.productId ?? '', productName: nameOf.get(l.productId ?? '') ?? 'A product', cans: l.quantityCans ?? 0 })),
  };
}

/** Let the refused order go, now that the new one is saved. */
export async function finishRetake(queueId: string): Promise<void> {
  const { discardRefused } = await import('../sync/queue');
  await discardRefused(queueId);
}

/**
 * TAKE BACK AN ORDER THAT HAS NOT LEFT THIS PHONE.
 *
 * An order still in the outbox could not be cancelled: the office had no TO
 * to cancel, so the card offered nothing, and `cancelTo` blamed Accounts for a
 * decision nobody had made. Its create has not gone, so it is removed here —
 * the outbox rows for it and anything queued behind it (an approval, an edit),
 * its lines and the row — and the office never hears of it. Never while it is
 * `syncing`: it may be landing this second, and the cancel then belongs to the
 * office.
 */
export async function discardUnsentOrder(orderId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const unsent = await one<{ id: string; state: string }>(UNSENT_CREATE_SQL, [orderId]);
  if (!unsent) {
    const flying = await one<{ id: string }>(
      "SELECT id FROM sync_queue WHERE entityType = 'order' AND entityId = ? AND op = 'create' AND state = 'syncing'",
      [orderId],
    );
    return {
      ok: false,
      message: flying
        ? 'It is being sent to the office right now. Wait a minute, then cancel it here once the office has it.'
        : 'The office already has this order, so it cannot be removed from the phone. Cancel it instead.',
    };
  }
  const approvals = await all<{ id: string }>('SELECT id FROM approvals WHERE subjectId = ?', [orderId]);
  await tx(async () => {
    for (const q of await all<{ id: string }>(ORDER_QUEUE_ROWS_SQL, [orderId])) {
      await run('DELETE FROM sync_queue WHERE id = ?', [q.id]);
    }
    for (const a of approvals) {
      await run("DELETE FROM sync_queue WHERE entityId = ? AND state <> 'synced'", [a.id]);
      await run('DELETE FROM approvals WHERE id = ?', [a.id]);
    }
    await run("DELETE FROM sync_queue WHERE entityType = 'order_change_request' AND state <> 'synced' AND payload LIKE ?", [`%${orderId}%`]);
    await run('DELETE FROM order_lines WHERE orderId = ?', [orderId]);
    await run("DELETE FROM timeline_events WHERE sourceRecordId = ? AND sourceApp = 'mbos'", [orderId]);
    await run('DELETE FROM orders WHERE id = ?', [orderId]);
  });
  return { ok: true };
}

/**
 * EDIT AN ORDER BEFORE ACCOUNTS DECIDE IT.
 *
 * The lines are rewritten here and the change goes up as an update the office
 * re-checks against the same bar as a new order — and refuses if accounts have
 * decided it meanwhile, in which case the refusal says to send a change request.
 * An order still in the outbox is edited the same way; the update waits behind
 * its create.
 */
export async function editOrder(args: {
  orderId: string;
  lines: CartLine[];
  assessment: OrderAssessment;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const order = await one<{ status: string; netTotalPaise: number | null; customerId: string }>(
    'SELECT status, netTotalPaise, customerId FROM orders WHERE id = ?',
    [args.orderId],
  );
  if (!order) return { ok: false, message: 'That order is not on this phone.' };
  if (!editableStatus(order.status)) {
    return { ok: false, message: 'Accounts have already decided this order. Send a change request instead.' };
  }
  const total = args.assessment.valuePaise ?? 0;
  const dependsOn = await waitBehindOrder(args.orderId);

  await tx(async () => {
    await run('DELETE FROM order_lines WHERE orderId = ?', [args.orderId]);
    for (const p of args.assessment.lines) {
      await run(
        `INSERT INTO order_lines (id, orderId, productId, productName, cans, boxes, litres, ratePaise, schemeApplied, lineTotalPaise)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [newId('line'), args.orderId, p.line.productId, p.line.productName, p.cans, p.boxes, p.litres,
         p.ratePaise, p.schemeNote, p.valuePaise],
      );
    }
  });

  await updateAndQueue({
    table: 'orders',
    entityType: 'order',
    id: args.orderId,
    patch: { netTotalPaise: args.assessment.valuePaise, valueUnavailable: args.assessment.valueUnavailable },
    payloadExtras: {
      totalAmountPaise: total,
      lines: args.assessment.lines.map((p) => ({
        productId: p.line.productId,
        quantityCans: p.cans,
        ratePaise: p.ratePaise ?? undefined,
      })),
    },
    dependsOn,
  });
  return { ok: true };
}

/**
 * CANCEL A TO HE TOOK, while Accounts have not approved it. The office
 * cancels it only while it is still a TO waiting for Accounts or sent back by
 * them, and refuses it otherwise - whatever this phone believed - so the
 * local row says cancelled at once and the pull puts it right if it was not.
 */
export async function cancelTo(orderId: string, reason: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const why = reason.trim();
  if (!why) return { ok: false, message: 'Say why it is cancelled.' };
  const order = await one<{ status: string; journeyEditable: number | null; netTotalPaise: number | null; customerId: string }>(
    'SELECT status, journeyEditable, netTotalPaise, customerId FROM orders WHERE id = ?',
    [orderId],
  );
  if (!order) return { ok: false, message: 'That order is not on this phone.' };
  if (order.journeyEditable !== 1) {
    /* Still on this phone is not "decided by Accounts" — it is not at the
       office at all, and is taken back here instead. */
    if (await one<{ id: string }>(UNSENT_CREATE_SQL, [orderId])) {
      return { ok: false, message: 'This order has not been sent yet. Remove it from the phone instead — the office never hears of it.' };
    }
    if (order.journeyEditable == null && editableStatus(order.status)) {
      return { ok: false, message: 'The office has not described this order back to the phone yet. Sync, then cancel it.' };
    }
    return { ok: false, message: 'Accounts have already approved or decided it. Ask the office to change it.' };
  }
  const dependsOn = await waitBehindOrder(orderId);
  await updateAndQueue({
    table: 'orders',
    entityType: 'order',
    id: orderId,
    patch: { status: 'cancelled', cancelReason: why, journeyEditable: 0 },
    payloadExtras: { cancelTo: true },
    dependsOn,
    location: false,
  });
  return { ok: true };
}

export type ChangeRequest = {
  id: string;
  orderId: string;
  status: 'pending' | 'accepted' | 'declined';
  note: string | null;
  decisionNote: string | null;
  totalAmountPaise: number | null;
  requestedAt: number | null;
  decidedAt: number | null;
  syncState: string;
  syncMessage: string | null;
};

/** The newest change request on each order he has asked about. */
export async function latestChangeRequests(): Promise<Map<string, ChangeRequest>> {
  const rows = await all<ChangeRequest>(
    'SELECT * FROM order_change_requests ORDER BY COALESCE(requestedAt, clientCreatedAt) DESC',
  );
  const map = new Map<string, ChangeRequest>();
  for (const r of rows) if (!map.has(r.orderId)) map.set(r.orderId, r);
  return map;
}

/**
 * ASK ACCOUNTS TO CHANGE AN ORDER THEY HAVE APPROVED.
 *
 * Nothing about the order moves on the phone: it stays what accounts approved
 * until they accept, and then the office's lines come back on the next pull.
 * The note is required — accounts decide on the reason as much as the lines.
 */
export async function requestOrderChange(args: {
  orderId: string;
  lines: CartLine[];
  assessment: OrderAssessment;
  note: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const order = await one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [args.orderId]);
  if (!order) return { ok: false, message: 'That order is not on this phone.' };
  if (editableStatus(order.status)) {
    return { ok: false, message: 'Accounts have not decided this order yet — edit it directly instead.' };
  }
  if (order.status !== 'approved') {
    return { ok: false, message: 'This order has moved past approval, so a change cannot be requested. Ring accounts.' };
  }
  const waiting = (await latestChangeRequests()).get(args.orderId);
  if (waiting?.status === 'pending' && waiting.syncState !== 'rejected') {
    return { ok: false, message: 'A change to this order is already waiting for accounts.' };
  }
  if (args.note.trim().length < 3) return { ok: false, message: 'Say why it needs to change — accounts decide on that.' };

  const base = await stamp('ochg');
  const total = args.assessment.valuePaise ?? 0;
  await insertAndQueue({
    table: 'order_change_requests',
    entityType: 'order_change_request',
    row: {
      ...base,
      orderId: args.orderId,
      status: 'pending',
      note: args.note.trim(),
      totalAmountPaise: total,
      linesJson: JSON.stringify(args.assessment.lines.map((p) => ({ productId: p.line.productId, product: p.line.productName, quantity: p.cans }))),
      requestedAt: base.clientCreatedAt,
    },
    payloadExtras: {
      orderId: args.orderId,
      totalAmountPaise: total,
      note: args.note.trim(),
      lines: args.assessment.lines.map((p) => ({
        productId: p.line.productId,
        quantityCans: p.cans,
        ratePaise: p.ratePaise ?? undefined,
      })),
    },
    dependsOn: await waitBehindOrder(args.orderId),
  });
  return { ok: true };
}
