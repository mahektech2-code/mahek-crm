import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/services/mbos-service";
import { refineRequest } from "@/lib/dictation-requests";

/* ---------------------------------------------------------------------------
 * Tighten what I just said, or rewrite it the way I have described.
 *
 * The handset's door onto the same text call the CRM's `/api/dictate/refine`
 * makes. It holds nothing between calls: Undo lives on the phone, because the
 * previous version is the phone's to remember.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  text: z.string().trim().min(1).max(20_000),
  mode: z.enum(["tighten", "rewrite"]),
  instruction: z.string().trim().max(500).optional(),
});

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Nothing to work on." }, { status: 400 });
  }

  const answer = await refineRequest(parsed.data);
  return NextResponse.json(answer.body, { status: answer.status });
}
