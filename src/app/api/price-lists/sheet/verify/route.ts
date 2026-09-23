import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { verifySheet } from "@/lib/services/price-sheet-service";
import type { PriceSheet } from "@/lib/price-sheet";

/**
 * READ THE PAPER BACK — the import pipeline run over a list being built.
 *
 * The editor posts its sheet; this draws the PDF, extracts its text, parses
 * it, matches it against the catalogue and compares, and answers with each
 * stage as it actually ran. Nothing is stored: this is a question about a
 * draft, and a draft is not issued until it is published.
 *
 * A route rather than an action for the same reason the upload is one — the
 * answer carries the extracted text and a stage log, and it is asked of a
 * sheet that can be a few hundred rows.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { allowed } = await checkCapability("pricelist.manage");
  if (!allowed) return NextResponse.json({ error: "Building a price list is not something you can do." }, { status: 403 });

  let sheet: PriceSheet;
  try {
    sheet = (await request.json()) as PriceSheet;
  } catch {
    return NextResponse.json({ error: "That sheet could not be read." }, { status: 400 });
  }
  if (!sheet?.columns || !sheet?.rows) return NextResponse.json({ error: "That is not a price sheet." }, { status: 400 });

  try {
    const { bytes: _bytes, ...rest } = await verifySheet(sheet);
    void _bytes;
    return NextResponse.json(rest);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The sheet could not be read back." }, { status: 500 });
  }
}
