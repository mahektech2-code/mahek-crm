import { notFound } from "next/navigation";
import { priceListDoorCanManage } from "@/lib/price-list-door";
import { requireUser } from "@/lib/auth";
import { changePageData } from "@/lib/services/price-change-page";
import { ChangeScreen } from "@/components/pricing/books/change-screen";

export const metadata = { title: "Price change — CRM — MahekOne" };

export default async function Page({ params }: { params: Promise<{ bookId: string; changeId: string }> }) {
  const { bookId, changeId } = await params;
  const user = await requireUser();
  const [data, canManage] = await Promise.all([changePageData(changeId, user.id), priceListDoorCanManage(user, "crm")]);
  if (!data || data.change.bookId !== bookId) notFound();
  return (
    <div className="p-6">
      <ChangeScreen basePath="/crm/price-lists" canManage={canManage} viewerId={user.id} {...data} />
    </div>
  );
}
