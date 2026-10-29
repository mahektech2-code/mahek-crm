import { notFound } from "next/navigation";
import { priceListDoorCanManage } from "@/lib/price-list-door";
import { requireUser } from "@/lib/auth";
import { bookPageData } from "@/lib/services/price-book-page";
import { BookScreen } from "@/components/pricing/books/book-screen";

export const metadata = { title: "Price book — Accounts — MahekOne" };

export default async function Page({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const user = await requireUser();
  const [data, canManage] = await Promise.all([bookPageData(bookId), priceListDoorCanManage(user, "accounts")]);
  if (!data) notFound();
  return (
    <div className="p-6">
      <BookScreen
        basePath="/accounts/price-lists"
        canManage={canManage}
        todayIso={data.todayIso}
        detail={data.detail}
        list={data.list}
        coverage={data.coverage}
        overrides={data.overrides}
        options={data.options}
        sits={data.sits}
      />
    </div>
  );
}
