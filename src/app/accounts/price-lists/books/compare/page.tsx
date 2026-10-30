import { notFound } from "next/navigation";
import { compareLists } from "@/lib/services/price-list-service";
import { bookIdOfList } from "@/lib/services/price-book-service";
import { RevisionCompare } from "@/components/pricing/books/revision-compare";

export const metadata = { title: "Compare prices — Accounts — MahekOne" };

export default async function Page({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  if (!a || !b) notFound();
  const [comparison, bookA, bookB] = await Promise.all([compareLists(a, b), bookIdOfList(a), bookIdOfList(b)]);
  if (!comparison) notFound();
  return (
    <div className="p-6">
      <RevisionCompare basePath="/accounts/price-lists" comparison={comparison} sameBook={!!bookA && bookA === bookB} bookId={bookB ?? bookA} />
    </div>
  );
}
