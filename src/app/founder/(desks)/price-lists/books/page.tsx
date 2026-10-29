import { priceListDoorCanManage } from "@/lib/price-list-door";
import { requireUser } from "@/lib/auth";
import { listBooks } from "@/lib/services/price-book-service";
import { BooksScreen } from "@/components/pricing/books/books-screen";

export const metadata = { title: "Price books — Founder Command Centre — MahekOne" };

/** Every price book, one row each. Same component in every door; `canManage` decides the controls. */
export default async function Page() {
  const user = await requireUser();
  const [books, canManage] = await Promise.all([listBooks(), priceListDoorCanManage(user, "founder")]);
  return (
    <div className="p-6">
      <BooksScreen basePath="/founder/price-lists" canManage={canManage} books={books} />
    </div>
  );
}
