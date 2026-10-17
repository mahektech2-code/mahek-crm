import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/services/mbos-service";
import { readLeadFromVoice } from "@/lib/services/lead-voice-service";

/* ---------------------------------------------------------------------------
 * What a salesman said about a shop in, the New lead form's answers out —
 * PROTOCOL: not a queued record.
 *
 * A plain request for the reason the card scan and the visit assistant are:
 * the answer is only worth anything while the form is open, and one that
 * arrived through the outbox tomorrow would fill a form already saved. So it
 * fails without signal and the handset says so; typing still works.
 *
 * It READS and writes nothing — see `lead-voice-service.ts`.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
/* One model call, with Sarvam behind it if OpenAI does not answer — each is
   allowed forty-five seconds by `readStructured`. */
export const maxDuration = 120;

const Body = z.object({
  text: z.string().max(8000),
  spoken: z.string().max(8000).default(""),
});

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "That could not be read." }, { status: 400 });
  }

  try {
    const result = await readLeadFromVoice(parsed.data);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: result.code === "validation" ? 400 : 422 },
      );
    }
    return NextResponse.json({ ok: true, ...result.data });
  } catch (e) {
    console.error("Lead by voice failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "That could not be read just now. Type the details instead — what you said is still in the box." },
      { status: 500 },
    );
  }
}
