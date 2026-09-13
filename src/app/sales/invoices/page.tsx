import { fieldInvoices } from "@/lib/services/sales-service";
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
 * The screen itself is a client component now. Filtering, searching, paging
 * and opening a bill are all answered without a round trip, and the chips
 * stopped being links that reloaded the page to change one word in the URL.
 * `?show=` is still read, because it is in bookmarks and in links.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const params = await searchParams;
  const all = await fieldInvoices();

  const show = (["all", "open", "overdue", "unstated"] as const).find(
    (s) => s === params.show,
  );

  return <InvoicesScreen all={all} initialShow={show ?? "open"} />;
}
