import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { sheetsForLists } from "@/lib/services/price-sheet-service";
import { renderPriceSheetsPdf } from "@/lib/price-sheet-pdf";
import { CSV_HEADERS, sheetCsvRows, type SheetProduct } from "@/lib/price-sheet";
import { toCsv } from "@/lib/csv";
import { calendarDate } from "@/lib/business-date";
import { pricingOptions } from "@/lib/services/price-list-service";

/**
 * SEVERAL PRICE LISTS OUT AT ONCE.
 *
 * `format=csv` is one file, one row per priced cell, every list in it — the
 * same columns a single list's export writes, so the spreadsheet can be read
 * back into the editor. `format=pdf` is one PDF with every list in it, one
 * after another, because thirty downloads the browser asks about one at a time
 * is not an export.
 *
 * Ids are named explicitly: the screen sends what is selected or what the
 * filter is showing, and an export never quietly means "everything".
 */
export const runtime = "nodejs";
export const maxDuration = 120;

const MAX = 100;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const format = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";
  if (!ids.length) return NextResponse.json({ error: "Choose at least one list." }, { status: 400 });
  if (ids.length > MAX) return NextResponse.json({ error: `At most ${MAX} lists in one export.` }, { status: 400 });

  const sheets = await sheetsForLists(ids);
  if (!sheets.length) return NextResponse.json({ error: "None of those lists exist." }, { status: 404 });
  // The date in Mumbai, not in UTC — an export taken at 2am IST is today's file.
  const stamp = calendarDate(new Date());

  if (format === "pdf") {
    const bytes = await renderPriceSheetsPdf(sheets.map((s) => s.sheet));
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="price-lists-${sheets.length}-${stamp}.pdf"`,
        "cache-control": "private, no-store",
      },
    });
  }

  const options = await pricingOptions();
  const products = new Map<string, SheetProduct>(options.products.map((p) => [p.id, p]));
  const rows = sheets.flatMap((s) => sheetCsvRows(s.sheet, products));
  const csv = "﻿" + toCsv([...CSV_HEADERS], rows);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="price-lists-${sheets.length}-${stamp}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
