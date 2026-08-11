import { all, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { insertLocal, stamp } from './write';
import { getConfig } from './config';
import { assessOrder } from '../engines/credit';
import { canValueOrders, derivedQuantities, lineValuePaise, type PriceSource } from '../engines/order';
import { applySchemes } from '../engines/schemes';

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
  canOrder: boolean;
  blockReason: string | null;
  valuePaise: number | null;
  valueUnavailable: boolean;
  decision: 'blocked' | 'ok' | 'needs_approval';
  reason: string;
  /* Null where the order could not be valued at all — an unvalued order is not
     an order that comfortably fits, and saying so is the whole point. */
  availablePaise: number | null;
  overByPaise: number;
  lines: {
    line: CartLine;
    cans: number; boxes: number; looseCans: number; litres: number | null;
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
 */
export async function assessCart(customerId: string, lines: CartLine[]): Promise<OrderAssessment> {
  const customer = await one<{
    creditBlocked: number; creditBlockReason: string | null;
    creditLimitPaise: number | null; outstandingPaise: number; submittedNotInvoicedPaise: number;
    customerType: string | null;
  }>('SELECT * FROM customers WHERE id = ?', [customerId]);

  const priceSource = await getConfig<PriceSource>('products.priceSource', 'unset');
  const approvalThreshold = await getConfig<number>('mbos.orders.approvalThresholdPaise', 0);
  const secondTier = await getConfig<number>('mbos.orders.secondTierThresholdPaise', 0);

  const schemes = await all<{ id: string; name: string; eligibility: string; benefit: string }>(
    'SELECT * FROM schemes WHERE active = 1',
  );

  const priced = lines.map((line) => {
    const q = derivedQuantities(line.cans, line.cansPerBox ?? 1, line.millilitresPerCan ?? 0);
    const valuePaise = lineValuePaise(
      priceSource,
      line.cans,
      { sellingPricePaise: line.sellingPricePaise },
      line.typedRatePaise ?? null,
    );
    return { line, ...q, valuePaise, schemeNote: null as string | null };
  });

  /* Only a SKU can be ordered, so the scheme engine keys on `skuId` — the same
     rule MahekOne's catalogue holds to. */
  const schemeResult = applySchemes(
    priced.map((p) => ({ skuId: p.line.productId, cans: p.cans, valuePaise: p.valuePaise })),
    customer?.customerType ?? null,
    schemes.map((s) => JSON.parse(s.benefit).level
      ? { id: s.id, name: s.name, ...JSON.parse(s.eligibility), ...JSON.parse(s.benefit) }
      : { id: s.id, name: s.name, ...JSON.parse(s.eligibility), ...JSON.parse(s.benefit) }),
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
    submittedPaise: customer?.submittedNotInvoicedPaise ?? 0,
    orderValuePaise: valuePaise,
    approvalThresholdPaise: approvalThreshold,
    secondTierThresholdPaise: secondTier,
  });

  return {
    canOrder: verdict.decision !== 'blocked',
    blockReason: verdict.decision === 'blocked' ? (customer?.creditBlockReason ?? verdict.reason) : null,
    valuePaise,
    valueUnavailable: !valuable || valuePaise === null,
    decision: verdict.decision,
    reason: verdict.reason,
    availablePaise: verdict.availablePaise,
    overByPaise: verdict.overByPaise,
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
  customerId: string;
  customerName: string;
  userId: string;
  visitId?: string | null;
  lines: CartLine[];
  assessment: OrderAssessment;
  paymentTermDays?: number | null;
}): Promise<{ orderId: string; needsApproval: boolean }> {
  const base = await stamp('order');
  const needsApproval = args.assessment.decision === 'needs_approval';

  await tx(async () => {
    await run(
      `INSERT INTO orders (id, customerId, userId, visitId, orderedAt, status, paymentTermDays,
                           netTotalPaise, valueUnavailable, clientCreatedAt, deviceId, syncState)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued')`,
      [
        base.id, args.customerId, args.userId, args.visitId ?? null, Date.now(),
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
         p.line.sellingPricePaise ?? p.line.typedRatePaise ?? null, p.schemeNote, p.valuePaise],
      );
    }

    /* The approval request is a record of its own, and the order's state is
       DERIVED from it — nothing sets a flag on the order independently. */
    if (needsApproval) {
      const approvalId = newId('approval');
      await insertLocal('approvals', {
        id: approvalId,
        type: args.assessment.overByPaise > 0 ? 'order_over_credit' : 'order_over_threshold',
        subjectType: 'order',
        subjectId: base.id,
        reason: args.assessment.reason,
        requestedAt: Date.now(),
        state: 'pending',
        clientCreatedAt: Date.now(),
        deviceId: base.deviceId,
        syncState: 'queued',
      });
      await run('UPDATE orders SET approvalId = ? WHERE id = ?', [approvalId, base.id]);
    }

    await insertLocal('timeline_events', {
      id: newId('tl'),
      customerId: args.customerId,
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
    await run('UPDATE customers SET lastOrderDate = ?, submittedNotInvoicedPaise = submittedNotInvoicedPaise + ? WHERE id = ?', [
      new Date().toISOString().slice(0, 10),
      args.assessment.valuePaise ?? 0,
      args.customerId,
    ]);
  });

  await enqueue({
    entityType: 'order',
    entityId: base.id,
    op: 'create',
    payload: {
      id: base.id,
      customerId: args.customerId,
      customerName: args.customerName,
      userId: args.userId,
      visitId: args.visitId ?? null,
      orderedAt: base.clientCreatedAt,
      netTotalPaise: args.assessment.valuePaise,
      valueUnavailable: args.assessment.valueUnavailable,
      needsApproval,
      lines: args.assessment.lines.map((p) => ({
        productId: p.line.productId, productName: p.line.productName,
        cans: p.cans, boxes: p.boxes, litres: p.litres,
        ratePaise: p.line.sellingPricePaise ?? p.line.typedRatePaise ?? null,
        lineTotalPaise: p.valuePaise,
      })),
      deviceId: base.deviceId,
      clientCreatedAt: base.clientCreatedAt,
    },
    dependsOn: args.visitId ? [args.visitId] : [],
  });

  return { orderId: base.id, needsApproval };
}

/**
 * What was sold today, from this handset.
 *
 * `valueUnavailable` is carried rather than folded into a zero: until a price
 * source is confirmed an order is worth what the salesman typed, and a
 * confident ₹0 on the home screen is worse than a blank.
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
      WHERE userId = ? AND orderedAt >= ? AND status <> 'cancelled'`,
    [userId, from],
  );
  return {
    count: row?.n ?? 0,
    valuePaise: row?.total ?? 0,
    valueUnavailable: (row?.unknown ?? 0) > 0,
  };
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function listOrders(customerId?: string) {
  return customerId
    ? all('SELECT * FROM orders WHERE customerId = ? ORDER BY orderedAt DESC', [customerId])
    : all('SELECT * FROM orders ORDER BY orderedAt DESC LIMIT 50');
}

export async function orderLines(orderId: string) {
  return all('SELECT * FROM order_lines WHERE orderId = ?', [orderId]);
}
