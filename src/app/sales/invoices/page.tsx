import {
  fieldInvoiceAges,
  fieldInvoiceTotals,
  fieldInvoicesPage,
  type FieldInvoiceShow,
} from "@/lib/services/sales-service";
import { InvoicesScreen } from "./invoices-screen";

export const metadata = { title: "Invoices — Sales Dashboard — MahekOne" };

/**
 * Every bill raised against the field's book.
 *
 * The design's phrase for the open column is exact and worth keeping: **what is
 * left on each after confirmed money only.** `paid_amount` counts confirmed
 * receipts and nothing else, so a bill a salesman has reported money against
 * still stands here at its full amount — which is precisely the row somebody
 * needs an explanation on rather than a row to hide.
 *
 * A bill can also be `unstated`: the sheet raised it and nobody has said
 * whether it was paid. It counts as neither paid nor owed, is held out of the
 * aging strip, and says so — presenting an unknown as a debt is the mistake
 * that put nine crore of imaginary collections on this screen's ancestors.
 *
 * **THE TILES USED TO DESCRIBE 300 BILLS AND SAY 8,682.** The read behind this
 * screen was `limit 300` with no count, and "Bills in all" printed that 300.
 * Every figure was computed from the three hundred biggest balances and
 * presented as the whole book — not slow, wrong, and wrong in the direction
 * nobody checks, because 300 is a plausible number of bills to have.
 *
 * So the three questions are asked separately now: one page of rows, one
 * aggregate for the figures, and the open bills for the strip. Which means the
 * chips, the search and the page all live in the URL — they narrow a database
 * query rather than an array, so they have to reach the server.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; q?: string; page?: string; per?: string }>;
}) {
  const params = await searchParams;

  const show = ((["all", "open", "overdue", "unstated"] as const).find(
    (s) => s === params.show,
  ) ?? "open") as FieldInvoiceShow;
  const q = params.q?.trim() || undefined;
  const perPage = Math.min(Math.max(Number(params.per) || 25, 1), 200);
  const page = Math.max(Number(params.page) || 1, 1);

  const [ledger, totals, ages] = await Promise.all([
    fieldInvoicesPage({ show, q }, { page, perPage }),
    fieldInvoiceTotals(),
    fieldInvoiceAges(),
  ]);

  return (
    <InvoicesScreen
      /* KEYED ON THE FILTER, so changing it remounts with fresh state rather
         than needing an effect to reset the search box and close an open bill.
         Every modal and drawer in this codebase does the same — see
         `ConfirmDialog` and `CallPanel`. */
      key={`${show}|${q ?? ""}`}
      rows={ledger.rows}
      total={ledger.total}
      totals={totals}
      ages={ages}
      show={show}
      query={q ?? ""}
      page={page}
      perPage={perPage}
    />
  );
}
