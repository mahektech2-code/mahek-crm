import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { toCsv } from "@/lib/csv";
import { groupOutstanding } from "@/lib/engines/outstanding";
import { listBills } from "@/lib/services/payment-service";

/**
 * WHO OWES WHAT, BILL BY BILL, AS A FILE.
 *
 * The Outstanding screens used to build this in the browser out of the array
 * they were paging — which was every open bill in the book, which is why the
 * page weighed 3.3 MB. Now that the screen holds twenty-five customers, an
 * export assembled from what is on screen would write out twenty-five and be
 * read as the book: the worst possible outcome of making a page faster,
 * because nothing about the file looks wrong.
 *
 * ONE ROUTE FOR BOTH DOORS, like the bill ledger's beside it. The CRM's screen
 * and this app's differ in where a customer's name leads; they do not differ
 * in what is owed, and two exports would be two answers to that.
 *
 * Bill by bill rather than a row per customer, because that is what somebody
 * does with this: takes it into a call and goes down the bills one at a time.
 * `groupOutstanding` is still what decides which of them is debt and which is
 * merely unspoken for — an `unstated` bill is in the file, said in words, and
 * never added into a balance.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });

  /* Gated the way the screens are. Scope still narrows WHICH bills come back,
     inside `listBills`, exactly as it does for the screen. */
  const apps = await listUserApps(user.id);
  if (!apps.includes("accounts") && !apps.includes("crm")) {
    return new NextResponse("Not your app", { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const overdueOnly = params.get("overdue") === "1";

  /* Deliberately NOT cut by financial year — the oldest debt on an account is
     usually last year's, and that is the first row anybody works. */
  const rows = groupOutstanding(await listBills({ openOnly: true })).filter(
    (r) =>
      (!query || r.customerName.toLowerCase().includes(query)) &&
      (!overdueOnly || r.oldestOverdueDays > 0),
  );

  const csv = toCsv(
    [
      "Customer",
      "Bill",
      "Billed",
      "Due",
      "Amount (₹)",
      "Received (₹)",
      "Open (₹)",
      "Days overdue",
      "Status",
    ],
    rows.flatMap((r) =>
      r.bills.map((b) => [
        r.customerName,
        b.billNo,
        b.billDate,
        b.dueDate,
        String(Math.round(b.amount / 100)),
        String(Math.round(b.paid / 100)),
        String(Math.round(b.balance / 100)),
        b.overdueDays ? String(b.overdueDays) : "",
        billWord(b),
      ]),
    ),
  );

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mahek-outstanding.csv"`,
      /* Never cached: a statement of what is owed is a statement about this
         moment, and a stale one is worse than a slow one. */
      "cache-control": "no-store",
    },
  });
}

/** The same sentence both screens' pills show, so the file and the table agree. */
function billWord(b: {
  unstated: boolean;
  disputed: boolean;
  overdueDays: number;
  paid: number;
}): string {
  if (b.unstated) return "Not stated";
  if (b.disputed) return "Disputed";
  if (b.overdueDays > 0) {
    return b.paid > 0 ? `Part paid · ${b.overdueDays}d late` : `${b.overdueDays}d overdue`;
  }
  return b.paid > 0 ? "Partly paid" : "Open";
}
