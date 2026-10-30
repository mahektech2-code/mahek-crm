"use server";

import { z } from "zod";
import { db } from "@/db";
import { requireCapability } from "@/lib/access-control";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { audit } from "@/lib/services/price-write";
import { notifyUsers } from "@/lib/notify";
import { money } from "@/lib/format";
import { activeUserIds, founderHolders, shopPeople, watchLineFor, watchReport } from "@/lib/services/price-watch-service";
import { aiSummariseWatch, type WatchSummary } from "@/lib/price-ai/watch-ai";
import { personOf } from "@/lib/engines/price-watch";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * WATCH THE MONEY — the three things a person can do from the Watch screen.
 *
 * Summarising is a READ: anybody who can see prices may ask, and the report it
 * reads is narrowed to their own book exactly as the screen is. Asking about
 * a line and sending to the founder WRITE (a bell, an audit row), so they are
 * the Price Desk's, checked here because a server action is a URL. None of it
 * changes a price: making a difference into a special price is the ordinary
 * special-price request, decided by somebody else.
 * ------------------------------------------------------------------------- */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const range = z.object({ from: z.string().regex(ISO), to: z.string().regex(ISO) }).refine((r) => r.from <= r.to, "The range ends before it starts.");

export async function summariseWatch(input: { from: string; to: string }): Promise<Result<WatchSummary>> {
  try {
    const ctx = await requireCapability("pricelist.read");
    const parsed = range.safeParse(input);
    if (!parsed.success) return err("Pick a range with a start on or before its end.", "validation");
    const report = await watchReport(parsed.data);
    const summary = await aiSummariseWatch({ report, from: parsed.data.from, to: parsed.data.to, userId: ctx.user.id });
    return ok(summary);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function askAboutLine(input: { lineId: string; orderDate: string; note?: string }): Promise<Result<{ told: number }>> {
  try {
    const ctx = await requirePriceDesk();
    if (!input.lineId || !ISO.test(input.orderDate)) return err("That line could not be read.", "validation");
    const line = await watchLineFor(input.lineId, input.orderDate);
    if (!line) return err("That line is not one you can see any more.", "not_found");
    if (line.listExPaise == null || line.deltaPaise == null || line.deltaPaise >= 0) {
      return err("That line is not billed below the book.", "validation");
    }

    const shop = line.customerId ? await shopPeople(line.customerId) : null;
    const taker = personOf(line);
    const recipients = await activeUserIds([
      ...(shop?.userIds ?? []),
      ...(taker.key.startsWith("user:") ? [taker.key.slice(5)] : []),
    ]);
    const others = recipients.filter((u) => u !== ctx.user.id);
    if (!others.length) {
      return err("Nobody with an account answers for this shop or took this line, so there is nobody to ask.", "validation");
    }

    const note = input.note?.trim().slice(0, 500);
    const body =
      `${line.customerName} was billed ${money(line.billedExPaise)} for ${line.productName} against ${money(line.listExPaise)} on the book ` +
      `(ex-GST, ${line.orderDate}${line.orderNumber ? `, order ${line.orderNumber}` : ""}) — why?` +
      (note ? ` ${ctx.user.name}: ${note}` : "");

    await db.transaction(async (tx) => {
      await audit(tx, ctx, {
        action: "pricelist.watch.ask",
        entityType: line.source === "erp" ? "erp_order" : "sheet_order_row",
        entityId: line.lineId,
        after: { customerId: line.customerId, productId: line.productId, billedExPaise: line.billedExPaise, listExPaise: line.listExPaise, told: others, note: note ?? null },
      });
    });
    await notifyUsers(
      others.map((userId) => ({
        userId,
        kind: "warn",
        title: `Billed below the book: ${line.customerName}`,
        body,
        href: line.customerId ? `/crm/customers/${line.customerId}` : null,
      })),
    );
    return ok({ told: others.length }, others.length === 1 ? "Asked. One person has been told." : `Asked. ${others.length} people have been told.`);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function sendToFounder(input: {
  from: string;
  to: string;
  /** A shop × product group's key, or empty for the whole window. */
  groupKey?: string | null;
  note?: string;
}): Promise<Result<{ told: number }>> {
  try {
    const ctx = await requirePriceDesk();
    const parsed = range.safeParse({ from: input.from, to: input.to });
    if (!parsed.success) return err("Pick a range with a start on or before its end.", "validation");
    const report = await watchReport(parsed.data);
    const group = input.groupKey ? report.byShopProduct.find((g) => g.key === input.groupKey) : null;
    if (input.groupKey && !group) return err("That group is not in this window any more.", "not_found");

    const founders = (await founderHolders()).filter((u) => u !== ctx.user.id);
    if (!founders.length) return err("Nobody else holds the Founder Dashboard to send this to.", "validation");

    const note = input.note?.trim().slice(0, 500);
    const window = `${parsed.data.from} to ${parsed.data.to}`;
    const title = group ? `Watch: ${group.customerName} — ${group.productName}` : `Watch: money below the book, ${window}`;
    const body = group
      ? `${group.lines} lines, ${group.cans} cans billed at ${money(group.billedMinPaise)}–${money(group.billedMaxPaise)} against ${group.listExPaise == null ? "—" : money(group.listExPaise)} on the book. Given away ${money(group.givenAwayPaise)} (${money(group.unapprovedPaise)} with nothing on record approving it), ${window}.`
      : `${report.totals.below} of ${report.totals.priced} priced lines billed below the book. Given away ${money(report.totals.givenAwayPaise)}, of which ${money(report.totals.unapprovedPaise)} has nothing on record approving it.`;
    const href = `/founder/price-lists/watch?preset=custom&from=${parsed.data.from}&to=${parsed.data.to}`;

    await db.transaction(async (tx) => {
      await audit(tx, ctx, {
        action: "pricelist.watch.founder",
        entityType: "price_watch",
        entityId: group ? group.key : window,
        after: { from: parsed.data.from, to: parsed.data.to, groupKey: group?.key ?? null, told: founders, note: note ?? null },
      });
    });
    await notifyUsers(
      founders.map((userId) => ({ userId, kind: "warn", title, body: note ? `${body} ${ctx.user.name}: ${note}` : `${body} Sent by ${ctx.user.name}.`, href })),
    );
    return ok({ told: founders.length }, "Sent to the founder.");
  } catch (e) {
    return fromThrown(e);
  }
}
