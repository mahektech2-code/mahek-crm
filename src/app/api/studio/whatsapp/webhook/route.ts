import { NextResponse } from "next/server";
import { readSecret } from "@/lib/secrets";
import { verifySignature } from "@/lib/studio/domain/inbox-signature";
import { applyWebhook } from "@/lib/studio/inbox-service";

/* Kapso's webhook for the company WhatsApp number. Public by necessity, so it
   proves itself: the signature is an HMAC-SHA256 of the RAW body under the
   secret kept in the Admin Console, and nothing is read or stored before it
   verifies. A delivery is recognised by Kapso's idempotency key, so a retry
   answers 200 and changes nothing. A failure we want retried answers 503;
   anything else Kapso sent us we answer 200 so it stops. */
export const dynamic = "force-dynamic";
const MAX_BYTES = 1_000_000;

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return NextResponse.json({ ok: false }, { status: 413 });
  const secret = await readSecret("kapso.webhookSecret");
  if (!verifySignature(raw, request.headers.get("x-webhook-signature"), secret)) return NextResponse.json({ ok: false }, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true, result: "ignored", reason: "not json" });
  }
  /* Batched deliveries are not asked for; one that arrives anyway is left to the refresh to pick up. */
  if (request.headers.get("x-webhook-batch") === "true") return NextResponse.json({ ok: true, result: "ignored", reason: "batched" });
  try {
    const out = await applyWebhook({ event: request.headers.get("x-webhook-event"), key: request.headers.get("x-idempotency-key"), body });
    return NextResponse.json({ ok: true, ...out }, { status: out.result === "unavailable" ? 503 : 200 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
