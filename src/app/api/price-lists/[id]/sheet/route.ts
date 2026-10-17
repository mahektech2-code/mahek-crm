import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { sheetForList } from "@/lib/services/price-sheet-service";

/**
 * A LIST AS THE EDITOR HOLDS IT — the header, the grid, the clauses and who it
 * applies to, as one `PriceSheet`. Read when somebody opens a list in the
 * editor, duplicates one, derives from one or starts a new version.
 */
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const found = await sheetForList(id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(found);
}
