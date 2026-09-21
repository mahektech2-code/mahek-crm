/*
 * ONE DOCUMENT, READ BACK — the Sales Dashboard's door.
 *
 * Everything the screen needs comes from two reads: the document with its
 * staged rows and the grid they form, and the pricing options the modals pick
 * from. A document that does not exist is a 404 rather than an empty screen —
 * a review page with nothing on it reads as a sync that has not finished.
 */
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { documentDetail, pricingOptions } from "@/lib/services/price-list-service";
import { today } from "@/lib/recompute";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { DocumentReviewScreen } from "@/components/pricing/document-review-screen";

export const metadata = { title: "Review a price list — Sales Dashboard — MahekOne" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const [detail, options, canManage, todayIso] = await Promise.all([
    documentDetail(id),
    pricingOptions(),
    canFor(user, "pricelist.manage"),
    today(),
  ]);

  if (!detail) notFound();

  return (
    <div className="p-6">
      <PricingSubNav basePath="/sales/price-lists" current="documents" />
      <DocumentReviewScreen
        app="sales"
        basePath="/sales/price-lists"
        canManage={canManage}
        todayIso={todayIso}
        document={detail.document}
        rows={detail.rows}
        grid={detail.grid}
        options={options}
        lists={options.lists}
      />
    </div>
  );
}
