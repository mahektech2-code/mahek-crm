import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { refineText } from "@/lib/dictation";

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

  const config = await getConfig();
  if (!config["voice.enabled"]) {
    return NextResponse.json(
      { ok: false, error: "Dictation is switched off." },
      { status: 403 },
    );
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Nothing to work on." }, { status: 400 });
  }

  /* A rewrite with no instruction is a reword nobody asked for. */
  if (parsed.data.mode === "rewrite" && !parsed.data.instruction) {
    return NextResponse.json(
      { ok: false, error: "Say what to change." },
      { status: 400 },
    );
  }

  const outcome = await refineText({
    text: parsed.data.text,
    mode: parsed.data.mode,
    instruction: parsed.data.instruction,
    languageModel: config["voice.languageModel"],
  });

  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          outcome.reason === "not_configured"
            ? "Dictation is not set up on this deployment yet."
            : "That did not come back. Your text is unchanged.",
      },
      { status: outcome.reason === "not_configured" ? 503 : 502 },
    );
  }

  return NextResponse.json({ ok: true, text: outcome.text });
}
