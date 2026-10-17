import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { sheetForList } from "@/lib/services/price-sheet-service";
import { pdfFilename, renderPriceSheetPdf } from "@/lib/price-sheet-pdf";

/**
 * ONE PRICE LIST AS THE PDF THE OFFICE SENDS.
 *
 * Drawn on request from the list's own rates, never from a stored file: the
 * stored document is what was ISSUED, and a draft being worked on has not been
 * issued. `?download=1` asks the browser to save it; without it the file opens
 * in a tab, which is what "preview" means to somebody about to forward it.
 *
 * `pricelist.read` — anybody who can see the list can have it on paper; that
 * is the whole point of a price list.
 */
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const found = await sheetForList(id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bytes = await renderPriceSheetPdf(found.sheet);
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${pdfFilename(found.sheet.name)}"`,
      "cache-control": "private, no-store",
    },
  });
}
