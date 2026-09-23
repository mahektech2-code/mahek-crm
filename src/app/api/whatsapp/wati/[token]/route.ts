import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { currentWebhookToken } from "@/lib/wati";
import { parseWatiEvent } from "@/lib/whatsapp-delivery";
import { applyWatiEvent } from "@/lib/services/whatsapp-service";

/* ---------------------------------------------------------------------------
 * Where Wati reports back: delivered, read, failed, and customers' replies.
 *
 * The path segment IS the credential — Wati's webhook settings take a URL and
 * nothing else — and it is derived from the API key (`webhookTokenFor`), so it
 * needs no setting of its own and rotates when the key does. The Founder
 * Dashboard's WhatsApp screen prints the full address to paste into Wati.
 *
 * Receiving does not depend on the founder's switch. The switch decides what
 * we SEND; a delivery tick for a message that already went, or a customer's
 * reply, is a fact about the world, and dropping it because sending has since
 * been switched off would leave the log saying "sent" about a message that was
 * read, and a customer's message unanswered.
 *
 * A wrong token answers 404, the same as a path that does not exist. Anything
 * else answers 200 — including an event we ignore — because Wati retries a
 * non-2xx, and retrying an event we have decided not to act on helps nobody.
 * ------------------------------------------------------------------------- */

function sameToken(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return timingSafeEqual(bufA, bufA) && false;
  return timingSafeEqual(bufA, bufB);
}

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const expected = await currentWebhookToken();
  if (!expected || !sameToken(token, expected)) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true, applied: "ignored: not JSON" });
  }

  // Wati sends one event per call; an array is accepted too, so a batched
  // delivery in future is not silently half-read.
  const events = Array.isArray(body) ? body : [body];
  const applied: string[] = [];
  for (const e of events.slice(0, 100)) {
    try {
      applied.push(await applyWatiEvent(parseWatiEvent(e)));
    } catch (error) {
      // One bad event must not cost the rest, and must not make Wati retry
      // the whole batch into the same failure for a day.
      console.error("[wati webhook] event failed", error);
      applied.push("error");
    }
  }
  return NextResponse.json({ ok: true, applied });
}

/** Wati (and a person checking the address) may probe with a GET. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const expected = await currentWebhookToken();
  if (!expected || !sameToken(token, expected)) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  return NextResponse.json({ ok: true, listening: "wati" });
}
