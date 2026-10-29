import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { documentChangePreview, importFactsFor } from "@/lib/services/price-import-service";

/**
 * WHICH BOOK THIS DOCUMENT LOOKS LIKE, AND WHAT THE READERS SAID — for the
 * import workbench, which draws the match banner without leaving the modal.
 * `?bookId=` answers instead with what the document would move on that book.
 * Read only.
 */
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bookId = new URL(request.url).searchParams.get("bookId");
  if (bookId) {
    const preview = await documentChangePreview(id, bookId);
    if (!preview) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ preview });
  }
  const facts = await importFactsFor(id);
  if (!facts.match) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(facts);
}
