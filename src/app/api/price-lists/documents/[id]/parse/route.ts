import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { parseDocument } from "@/lib/services/price-list-parse-service";

/**
 * READ THIS DOCUMENT NOW.
 *
 * Its own call, so the screen can start one file, watch it through the status
 * endpoint and start the next — which is what makes the parsing animation a
 * report of something happening rather than a decoration over a single
 * request nobody can see inside.
 *
 * It answers the terminal status rather than throwing: every way this can go
 * wrong is already recorded on the document as `failed` with the reason, and
 * the screen reads that the same way it reads success.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { allowed } = await checkCapability("pricelist.manage");
  if (!allowed) {
    return NextResponse.json({ error: "Reading a price list in is not something you can do." }, { status: 403 });
  }

  const result = await parseDocument(id);
  return NextResponse.json(result);
}
