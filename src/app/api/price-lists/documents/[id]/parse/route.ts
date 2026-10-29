import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { NotPermittedError } from "@/lib/access-control";
import { requirePriceDesk } from "@/lib/services/price-desk";
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
 *
 * TWO THINGS ARE REFUSED, with 409, exactly as `reparseDocument` refuses them:
 * a document that is published or rejected (re-reading a published file put it
 * back to "parsed", where it could be published as a second list), and one a
 * live read already holds (two reads doubled every staged row). The claim is
 * made inside `parseDocument`, so this route and the action cannot disagree.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // The desk, as every other import action asks — the capability alone let a
  // clerk narrowed off Price lists read files in through this URL.
  try {
    await requirePriceDesk();
  } catch (e) {
    if (e instanceof NotPermittedError) {
      return NextResponse.json({ error: "Reading a price list in is not something you can do." }, { status: 403 });
    }
    throw e;
  }

  const result = await parseDocument(id);
  if (result.refused) return NextResponse.json({ ...result, error: result.problems[0] }, { status: 409 });
  return NextResponse.json(result);
}
