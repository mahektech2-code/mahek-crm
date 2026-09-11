import { notFound } from "next/navigation";
import { performance, salesmanRecord } from "@/lib/services/sales-service";
import { endOfMonth } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { SalesmanScreen } from "./salesman-screen";

export const metadata = { title: "Salesman — Sales Dashboard — MahekOne" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = await today();

  /* This month and the one before it, from the SAME function the team's
     Performance screen reads. Not a query of its own: a figure on a person's
     record and the same figure on the team list have to come from one place,
     or the two screens disagree about what somebody did and there is no way to
     tell which is right. It returns the whole team and this picks one row —
     wasteful on a large team, correct on every team, and the alternative is a
     second spelling of twenty subqueries. */
  const thisMonth = now.slice(0, 7);
  const lastMonth = new Date(`${thisMonth}-01T00:00:00Z`);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const previous = lastMonth.toISOString().slice(0, 7);

  const [record, current, before] = await Promise.all([
    salesmanRecord(id),
    performance(`${thisMonth}-01`, endOfMonth(thisMonth)),
    performance(`${previous}-01`, endOfMonth(previous)),
  ]);

  /* `salesmanRecord` answers null for anybody who does not hold the field app,
   * which covers both "no such person" and "not in the field" — the two are
   * the same answer here, and neither confirms to a URL-guesser that an id
   * belongs to a real account. */
  if (!record) notFound();

  return (
    <SalesmanScreen
      record={record}
      month={thisMonth}
      thisMonth={current.find((r) => r.salesmanId === id) ?? null}
      lastMonth={before.find((r) => r.salesmanId === id) ?? null}
    />
  );
}
