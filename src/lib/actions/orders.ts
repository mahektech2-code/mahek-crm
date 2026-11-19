"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  accountsOrderEdit,
  approveOrder,
  declineOrder,
  editOrderByAccounts,
  holdOrderForAccounts,
  releaseOrderForAccounts,
  type AccountsOrderEditView,
} from "@/lib/services/order-approval-service";
import { err, fromThrown, type Result } from "@/lib/result";
import { requireCapability } from "@/lib/access-control";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";

/**
 * Thin over the service, which owns the capability check. Approving is
 * verified there and not merely hidden here — a disabled button is a
 * courtesy, not a permission.
 */
function refresh() {
  try {
    revalidatePath("/accounts");
    revalidatePath("/apps");
    revalidatePath("/crm/dashboard");
    revalidatePath("/crm/eod");
  } catch {
    /* no request context — nothing cached to invalidate */
  }
}

export async function approveOrderAction(orderId: string): Promise<Result> {
  try {
    const r = await approveOrder(orderId);
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * The reason first, then the impact modal (`accounts-order-decline`): the
 * buying cycle, the taker's bell, the ERP lines. Checked after the capability
 * and only once there is a reason, so a missing reason keeps the service's
 * own words. HQ declines through `declineOrder` directly, behind its own
 * reason form and confirmation.
 */
export async function declineOrderAction(
  orderId: string,
  reason: string,
  confirmation?: ImpactConfirmation | null,
): Promise<Result> {
  try {
    await requireCapability("order.approve");
    if (reason.trim()) {
      const refusal = await confirmImpact("accounts-order-decline", orderId, confirmation);
      if (refusal) return refusal;
    }
    const r = await declineOrder(orderId, reason);
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** Accounts hold an order made through the Order Hub: it leaves the queue until released. */
export async function holdOrderAction(orderId: string, reasonCode: string, note: string, opts: { customerText?: string | null; lookAgainOn?: string | null } = {}): Promise<Result> {
  try {
    const r = await holdOrderForAccounts(orderId, reasonCode, note, opts);
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** Releasing puts it back in the queue, to be decided again. */
export async function releaseOrderAction(orderId: string, note: string): Promise<Result> {
  try {
    const r = await releaseOrderForAccounts(orderId, note);
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** The order's lines for Accounts' Edit order dialog. The service checks who is asking. */
export async function loadOrderEditAction(orderId: string): Promise<Result<AccountsOrderEditView>> {
  try {
    return await accountsOrderEdit(orderId);
  } catch (e) {
    return fromThrown(e);
  }
}

/*
 * LINES ONLY, AND NOTHING ELSE IS ACCEPTED. `strict` refuses a body that also
 * names a billing or delivery party or a godown — those are not Accounts' to
 * change — rather than quietly dropping the key and saving the rest.
 */
const accountsLine = z
  .object({
    lineId: z.string().min(1).nullable(),
    skuId: z.string(),
    qtyCans: z.number(),
    ratePaise: z.number().int().nullable(),
    discountBp: z.number().int().nullable(),
  })
  .strict();
const accountsEdit = z.object({ lines: z.array(accountsLine).max(500) }).strict();
const NOT_ACCOUNTS = ["billing", "billingId", "billingCustomerId", "delivery", "deliveryId", "deliveryCustomerId", "godown", "godownId"];

/** Accounts change an order's lines while it waits for their approval. */
export async function editOrderAction(orderId: string, input: { lines: z.input<typeof accountsLine>[] }): Promise<Result> {
  try {
    const named = Object.keys(input ?? {}).filter((k) => NOT_ACCOUNTS.includes(k));
    if (named.length || (input?.lines ?? []).some((l) => Object.keys(l ?? {}).some((k) => NOT_ACCOUNTS.includes(k))))
      return err("Accounts change the lines only. The billing party, the delivery party and the godown stay as they are — decline the order if one is wrong.", "not_permitted");
    const parsed = accountsEdit.safeParse(input);
    if (!parsed.success) return err("Those lines could not be read. Open the order again.", "validation");
    const r = await editOrderByAccounts(orderId, parsed.data.lines);
    if (r.ok) {
      refresh();
      try {
        revalidatePath("/erp/orders");
      } catch {
        /* no request context */
      }
    }
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}
