import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/access-control";
import { orderLines, pendingOrders } from "@/lib/services/order-approval-service";
import { openBillsFor, pendingReceipts } from "@/lib/services/receipt-service";
import { pendingCreditNotes } from "@/lib/services/credit-note-service";
import type { QueueDetail } from "@/app/accounts/queue-types";

/* ---------------------------------------------------------------------------
 * What the review drawer needs once a row is opened.
 *
 * Loaded a row at a time rather than sent with the list: an order can carry
 * hundreds of lines, a complaint several photographs, and the queue itself
 * needs neither to show a count.
 *
 * The capability is re-checked here. An endpoint that trusted the screen not
 * to call it would be a way for anybody signed in to read the whole approval
 * queue's detail, one id at a time.
 * ------------------------------------------------------------------------- */

export async function GET(request: Request) {
  try {
    await requireCapability("payment.record");
  } catch {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const id = url.searchParams.get("id");
  if (!id || !kind) {
    return NextResponse.json({ error: "kind and id are required" }, { status: 400 });
  }

  if (kind === "orders") {
    const order = (await pendingOrders()).find((o) => o.orderId === id);
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const lines = await orderLines(id);
    const detail: QueueDetail = {
      kind: "orders",
      outstanding: order.outstanding,
      overdueBills: order.overdueBills,
      slowPayer: order.slowPayer,
      creditDays: order.creditDays,
      lineCount: order.lineCount,
      takenByName: order.takenByName,
      orderedAt: order.orderedAt.toISOString(),
      // An empty part is dropped rather than joined — imported customers
      // often carry no contact person and no city.
      contact: [order.contactPerson, order.phone, order.customerCity]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(" · "),
    };
    return NextResponse.json({ detail, lines });
  }

  if (kind === "payments") {
    const receipt = (await pendingReceipts()).find((r) => r.receiptId === id);
    if (!receipt) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const onAccount = receipt.lines
      .filter((l) => !l.billId)
      .reduce((s, l) => s + l.amount, 0);
    // What is still open on the account, so the drawer can offer somewhere
    // else to put the money. `reported` on a bill is what OTHER undecided
    // receipts have already claimed of it — this receipt's own claim is
    // subtracted, or re-pointing it at the bill it already names would find
    // its own money in the way.
    const own = new Map<string, number>();
    for (const l of receipt.lines) {
      if (l.billId) own.set(l.billId, (own.get(l.billId) ?? 0) + l.amount);
    }
    const open = await openBillsFor(receipt.customerId);

    const detail: QueueDetail = {
      kind: "payments",
      mode: receipt.mode,
      reference: receipt.reference,
      receivedAt: receipt.receivedAt,
      note: receipt.note,
      source: receipt.source,
      reportedAt: receipt.reportedAt,
      outstanding: receipt.outstanding,
      lines: receipt.lines,
      onAccount,
      instrumentDate: receipt.instrumentDate,
      bankableNow: receipt.bankableNow,
      bankableDays: receipt.bankableDays,
      status: receipt.status,
      heldByName: receipt.heldByName,
      holdReason: receipt.holdReason,
      heldDays: receipt.heldDays,
      holdStale: receipt.holdStale,
      openBills: open.map((b) => ({
        id: b.id,
        billNo: b.billNo,
        billDate: b.billDate,
        dueDate: b.dueDate,
        balance: b.balance,
        claimed: Math.max(0, b.reported - (own.get(b.id) ?? 0)),
        daysOverdue: b.daysOverdue,
      })),
    };
    return NextResponse.json({ detail });
  }

  if (kind === "credits") {
    const request_ = (await pendingCreditNotes()).find((c) => c.complaintId === id);
    if (!request_) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const detail: QueueDetail = {
      kind: "credits",
      categoryLabel: request_.categoryLabel,
      description: request_.description,
      goodsDescription: request_.goodsDescription,
      raisedAt: request_.raisedAt.toISOString(),
      billNo: request_.billNo,
      billBalance: request_.billBalance,
      outstanding: request_.outstanding,
      photos: request_.photos,
      requestedAmount: request_.amount,
    };
    return NextResponse.json({ detail });
  }

  return NextResponse.json({ error: "Unknown queue" }, { status: 400 });
}
