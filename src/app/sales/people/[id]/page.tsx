import { notFound } from "next/navigation";
import { salesmanRecord } from "@/lib/services/sales-service";
import { SalesmanScreen } from "./salesman-screen";

export const metadata = { title: "Salesman — Sales Dashboard — MahekOne" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await salesmanRecord(id);

  /* `salesmanRecord` answers null for anybody who does not hold the field app,
   * which covers both "no such person" and "not in the field" — the two are
   * the same answer here, and neither confirms to a URL-guesser that an id
   * belongs to a real account. */
  if (!record) notFound();

  return <SalesmanScreen record={record} />;
}
