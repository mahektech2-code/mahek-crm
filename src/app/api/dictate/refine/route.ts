import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { refineRequest } from "@/lib/dictation-requests";

/* ---------------------------------------------------------------------------
 * Tighten this, or rewrite it the way I just described.
 *
 * Separate from transcription because it is a separate decision. The English
 * the modal shows first is faithful to what was said; shortening it is
 * something the person asks for, having read it, and can undo by pressing
 * Undo — which is why the previous text is kept on the client rather than
 * here. This endpoint holds nothing between calls.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  text: z.string().trim().min(1).max(20_000),
  mode: z.enum(["tighten", "rewrite"]),
  instruction: z.string().trim().max(500).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Nothing to work on." }, { status: 400 });
  }

  const answer = await refineRequest(parsed.data);
  return NextResponse.json(answer.body, { status: answer.status });
}
