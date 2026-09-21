import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { priceListDetail } from "@/lib/services/price-list-service";
import { PrintSheet } from "@/components/pricing/print-sheet";

export const metadata = { title: "Price list — print — MahekOne" };

/**
 * The sheet the office actually sends out.
 *
 * It is a server component with one client control on it, because nothing on
 * the paper changes: the letterhead, the grid of GST-inclusive figures, the
 * terms and the signature are the list's own facts rendered in the shape Mahek
 * has always printed them.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUser();
  const detail = await priceListDetail(id);
  if (!detail) notFound();
  return <PrintSheet detail={detail} backHref={`/accounts/price-lists/${id}`} />;
}
