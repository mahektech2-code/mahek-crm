import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { sheetForList } from "@/lib/services/price-sheet-service";
import { PrintSheet } from "@/components/pricing/print-sheet";

export const metadata = { title: "Price list — print — MahekOne" };

/**
 * The sheet the office actually sends out, drawn from the same model as its
 * PDF — so the page printed from here and the file downloaded beside it are
 * one document.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUser();
  const found = await sheetForList(id);
  if (!found) notFound();
  return <PrintSheet sheet={found.sheet} listId={id} backHref={`/crm/price-lists/${id}`} />;
}
