import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { toCsv } from "@/lib/csv";
import { listBills } from "@/lib/services/payment-service";

/**
 * THE WHOLE YEAR AS A FILE, built on the server.
 *
 * The Bills screen used to hold every row of the year in the browser, which is
 * how its export worked: the CSV was assembled from the array React was
 * already paging. Now that the screen fetches one page, that array is gone —
 * and an export that quietly wrote out the 25 rows on screen would be the
 * worst possible outcome of making the page faster. Somebody would open the
 * file, see a page, and believe it was the year.
 *
 * So the export asks for what it means: the whole filtered set, once, when
 * somebody presses the button — rather than on every load of a screen where
 * most people never press it.
 *
 * It is also the cheaper place to build it. Ten thousand rows of CSV assembled
 * in a browser on a mid-range Android is slower than the query that produced
 * them; here it is a string.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });

  /* Gated the way the screen it belongs to is. A route that hands out the
     whole bill ledger must not be reachable by anybody whose app list does not
     include a ledger — scope still narrows WHICH bills come back, inside
     `listBills`, exactly as it does for the screen. */
  const apps = await listUserApps(user.id);
  if (!apps.includes("accounts") && !apps.includes("crm")) {
    return new NextResponse("Not your app", { status: 403 });
  }

  /*
   * THE CRM'S LEDGER EXPORTS THROUGH HERE TOO, and deliberately not through a
   * route of its own. The two screens differ in what surrounds the table —
   * where a customer's name leads, whose reminder is one click away — and not
   * at all in what a bill IS. Two routes would be two answers to "the bill
   * ledger as a file", and the one that drifts is the one somebody opens in a
   * meeting.
   *
   * So it takes the same filters the screens put in their URL. The aging
   * bucket is the exception: it is `agingBucket(effectiveDueDate(...))`, which
   * no query can see, so it is applied to the rows on the way past — which
   * costs nothing here, because an export reads the whole filtered set anyway.
   */
  const params = new URL(request.url).searchParams;
  const fy = params.get("fy") ?? undefined;
  const customerId = params.get("customer") ?? undefined;
  const status = params.get("status") ?? undefined;
  const bucket = params.get("bucket");

  const all = await listBills({ financialYear: fy, customerId, status });
  const rows = bucket ? all.filter((r) => r.balance > 0 && r.bucket === bucket) : all;

  const csv = toCsv(
    [
      "Bill",
      "Customer",
      "Billed",
      "Due",
      "Amount (₹)",
      "Received (₹)",
      "Open (₹)",
      "Days overdue",
      /* The band the row sits in. It was on the CRM's own export and not on
         this one, which is exactly the kind of difference that made two
         exports feel necessary. */
      "Aging bucket",
      "Status",
    ],
    rows.map((r) => [
      r.billNo,
      r.customerName,
      r.billDate,
      r.dueDate,
      String(Math.round(r.amount / 100)),
      String(Math.round(r.paid / 100)),
      String(Math.round(r.balance / 100)),
      r.overdueDays ? String(r.overdueDays) : "",
      r.balance > 0 ? r.bucket : "",
      statusWord(r),
    ]),
  );

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mahek-bills-${fy ?? "all"}.csv"`,
      /* Never cached. A ledger export is a statement about this moment, and a
         stale one is worse than a slow one. */
      "cache-control": "no-store",
    },
  });
}

/** The same sentence the screen's pill shows, so the file and the table agree. */
function statusWord(r: {
  disputed: boolean;
  balance: number;
  overdueDays: number;
  paid: number;
}): string {
  if (r.disputed) return "Disputed";
  if (r.balance <= 0) return "Paid";
  if (r.overdueDays > 0) {
    return r.paid > 0 ? `Part paid · ${r.overdueDays}d late` : `${r.overdueDays}d overdue`;
  }
  return r.paid > 0 ? "Partly paid" : "Open";
}
