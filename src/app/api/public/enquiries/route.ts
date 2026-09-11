import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readSecret } from "@/lib/secrets";
import { createEnquiryFromWebsite } from "@/lib/services/enquiry-service";
import { parseIngestPayload, MAX_INGEST_BODY_BYTES } from "@/lib/enquiry-ingest-validation";

/* ---------------------------------------------------------------------------
 * The website's own backend forwards a submission here, after ITS OWN
 * honeypot check, rate limit, and per-form validation have already passed —
 * this endpoint never sees a request a browser sent directly, and its own
 * job is narrower than any of that: create one enquiry row, nothing else.
 *
 * No session, no capability, no scope — a bearer secret is the whole of its
 * authority (`ENQUIRY_INGEST_SECRET`, via lib/secrets.ts, the same pattern
 * every other server-to-server credential in this app already uses). It
 * cannot list, read, or update anything; there is no code path here that
 * touches an existing row except the idempotent-replay check on
 * `externalRef`, which only ever returns an id already created by this same
 * route.
 *
 * `formType`/`category` are the website's own vocabulary
 * (src/types/enquiry.ts in that repo), duplicated here rather than shared,
 * because nothing can be imported across two repositories — keep this list
 * in step with that one if the website ever adds a ninth form.
 * ------------------------------------------------------------------------- */

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Different lengths must still take the constant-time path on SOME
  // comparison, or the length itself leaks through timing — compared against
  // itself rather than short-circuiting straight to `false`.
  if (bufA.length !== bufB.length) return timingSafeEqual(bufA, bufA) && false;
  return timingSafeEqual(bufA, bufB);
}

function reject(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = await readSecret("enquiries.ingestSecret");
  if (!secret) {
    // Fail closed: an ingestion endpoint with no configured secret is not a
    // safe default, the same reasoning /api/hrms/sync and /api/sheets/sync
    // already follow.
    return reject("Not configured.", 503);
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!presented || !safeTimingEqual(presented, secret)) {
    return reject("Not authorised.", 401);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INGEST_BODY_BYTES) {
    return reject("Request too large.", 413);
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_INGEST_BODY_BYTES) {
      return reject("Request too large.", 413);
    }
    raw = JSON.parse(text);
  } catch {
    return reject("Invalid request body.", 400);
  }

  const parsed = parseIngestPayload(raw);
  if (!parsed.ok) {
    return reject(parsed.error, 400);
  }
  const { formType, externalRef, receivedAt, submission } = parsed.data;

  try {
    const result = await createEnquiryFromWebsite({
      sourceForm: formType,
      externalRef,
      receivedAt: new Date(receivedAt),
      submission,
    });

    // Form type, id and whether this was a replay — never the payload itself
    // (a visitor's name/phone/message has no business in a server log) and
    // never the secret that authenticated the call.
    console.log(
      `[api/public/enquiries] ${formType} -> ${result.id}${result.duplicate ? " (duplicate externalRef, already recorded)" : ""}`,
    );

    return NextResponse.json({ ok: true, id: result.id, duplicate: result.duplicate || undefined }, { status: 200 });
  } catch (e) {
    console.error("[api/public/enquiries] failed to store enquiry:", e);
    return reject("Could not record the enquiry right now.", 502);
  }
}
