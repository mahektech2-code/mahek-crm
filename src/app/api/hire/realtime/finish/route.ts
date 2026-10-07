import { NextResponse } from "next/server";
import { hireContext } from "@/lib/hire/access";
import { FinishPayload, saveVoiceScreen } from "@/lib/hire/services/voice";

export const maxDuration = 300;

/**
 * The end of an AI voice screen: the transcript and, only where the candidate
 * agreed, the recording. A route handler rather than a server action because
 * ten minutes of audio is past the 1MB action body limit.
 */
export async function POST(req: Request) {
  const ctx = await hireContext();
  if (!ctx || !ctx.can("interview")) return NextResponse.json({ ok: false, error: "Saving a screen needs an interviewing role in Hire." }, { status: 403 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ ok: false, error: "Nothing was sent." }, { status: 400 });
  const parsed = FinishPayload.safeParse(JSON.parse(String(form.get("payload") ?? "null")));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "The transcript could not be read." }, { status: 400 });
  const audio = form.get("audio");
  const r = await saveVoiceScreen(ctx, parsed.data, audio instanceof File ? audio : null);
  return NextResponse.json(r, { status: r.ok ? 200 : 422 });
}
