import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { documentStatus } from "@/lib/services/price-list-parse-service";

/**
 * HOW FAR THE READING HAS GOT.
 *
 * Polled every second or so while a file is being read, so it is deliberately
 * one row and four counts. Held to `pricelist.read` rather than to manage:
 * watching a document being read tells somebody nothing they could not see on
 * the list it becomes, and a telecaller who opened the screen mid-import
 * should not be met with a refusal.
 */
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const status = await documentStatus(id);
  if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(status);
}
