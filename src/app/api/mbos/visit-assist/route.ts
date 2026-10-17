import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/services/mbos-service";
import { analyseVisit } from "@/lib/services/visit-intel-service";

/* ---------------------------------------------------------------------------
 * Read what the salesman said about a visit, and propose what it implies.
 *
 * The handset's door onto the visit assistant. A route rather than a sync
 * entity for the reason dictation is one: the answer is only worth anything
 * while he is still standing in the shop, and a proposal that arrived through
 * the outbox tomorrow would be a suggestion about a visit already saved. So it
 * fails without signal, and the screen says so rather than queueing it.
 *
 * It READS. The one row it writes is the draft — nothing a salesman or the
 * office would call a record.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  customerId: z.string().trim().min(1),
  spoken: z.string().max(8000).default(""),
  english: z.string().max(8000).default(""),
  typedNote: z.string().max(8000).default(""),
  language: z.string().max(20).nullable().default(null),
  heardBy: z.enum(["sarvam", "openai", "typed", "dictated"]).default("typed"),
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
    return NextResponse.json(
      { ok: false, error: "That could not be read." },
      { status: 400 },
    );
  }

  try {
    const result = await analyseVisit(auth.principal, parsed.data);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 422 },
      );
    }
    return NextResponse.json({ ok: true, ...result.data });
  } catch (e) {
    console.error(
      "Visit assistant failed:",
      e instanceof Error ? e.message : e,
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          "The assistant could not read that just now. Fill the visit as usual — nothing is lost.",
      },
      { status: 500 },
    );
  }
}
