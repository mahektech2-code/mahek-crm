import "server-only";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { pricingOptions } from "@/lib/services/price-list-service";
import { changeDetail } from "@/lib/services/price-book-service";
import { aiReadiness } from "@/lib/price-ai/providers";
import { priceDeskPeople } from "@/lib/services/price-desk-people";

/** Everything a change's page draws, shared by the three doors. */
export async function changePageData(changeId: string, viewerId: string) {
  const [change, config, todayIso, ai, options, desk] = await Promise.all([
    changeDetail(changeId),
    getConfig(),
    today(),
    aiReadiness(),
    pricingOptions(),
    priceDeskPeople(),
  ]);
  if (!change) return null;
  const onDraft = new Set(change.draft.map((r) => r.productId));
  return {
    change,
    todayIso,
    ai,
    makerChecker: config["pricing.changes.makerChecker"],
    otherDeskPeople: desk.filter((p) => p.id !== viewerId && p.id !== change.maker.id).length,
    /** Products the book does not price yet, for "Add a product". Active ones only. */
    addable: options.products
      .filter((p) => p.active && !onDraft.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, millilitresPerCan: p.millilitresPerCan, family: p.brandName ?? p.name.split(" - ")[0] })),
  };
}
