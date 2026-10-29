import "server-only";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { ladderBreaks } from "@/lib/engines/price-change";
import { priceListDetail, pricingOptions, varianceReport } from "@/lib/services/price-list-service";
import {
  bookCoverage,
  bookDetail,
  changeRatesOf,
  listOverrides,
  neighbourRates,
  shopResolutions,
} from "@/lib/services/price-book-service";
import type { BookSits } from "@/lib/price-book-views";

/**
 * Everything a book's page draws, read once: the book, the revision shown,
 * who it covers, the overrides on its shops, and how it sits against the
 * other books. Shared by the three doors.
 */
export async function bookPageData(bookId: string) {
  const day = await today();
  const detail = await bookDetail(bookId);
  if (!detail) return null;
  const liveId = detail.book.live?.listId ?? null;
  const [list, coverage, options, shops, overrides] = await Promise.all([
    detail.shownListId ? priceListDetail(detail.shownListId) : Promise.resolve(null),
    liveId ? bookCoverage(liveId, day) : Promise.resolve(null),
    pricingOptions(),
    shopResolutions(day),
    listOverrides(),
  ]);
  const shopIds = new Set(shops.filter((s) => s.resolution?.candidates.some((c) => c.listId === liveId)).map((s) => s.customerId));
  const onBook = overrides.filter((o) => shopIds.has(o.customerId));

  let sits: BookSits | null = null;
  if (liveId) {
    const [rates, others, variance] = await Promise.all([
      changeRatesOf(liveId),
      neighbourRates(bookId, day),
      varianceReport(addDays(`${day.slice(0, 7)}-01`, -1).slice(0, 7)),
    ]);
    const byProduct = new Map<string, number[]>();
    for (const n of others) byProduct.set(n.productId, [...(byProduct.get(n.productId) ?? []), n.rateExGstPaise]);
    const moves: number[] = [];
    for (const r of rates) {
      if ((r.minCans ?? 0) !== 0 || !r.offered || r.rateExGstPaise <= 0) continue;
      const v = byProduct.get(r.productId);
      if (!v?.length) continue;
      const avg = v.reduce((a, b) => a + b, 0) / v.length;
      moves.push(((r.rateExGstPaise - avg) * 10_000) / avg);
    }
    const bookLists = new Set(detail.revisions.map((r) => r.listId));
    const below = variance.rows.filter((r) => r.listId && bookLists.has(r.listId) && (r.deltaPaise ?? 0) < 0);
    sits = {
      ladderBreaks: ladderBreaks(rates).map((f) => f.message),
      vsBooksBp: moves.length ? Math.round(moves.reduce((a, b) => a + b, 0) / moves.length) : null,
      sharedProducts: moves.length,
      belowLastMonth: {
        lines: below.length,
        givenAwayPaise: below.reduce((sum, r) => sum + Math.abs(r.deltaPaise ?? 0) * (r.cans ?? 1), 0),
      },
    };
  }
  return { detail, list, coverage, options, overrides: onBook, sits, todayIso: day };
}
