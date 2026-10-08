import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { mbosClientErrors } from "@/db/schema";
import { authenticate, reportedVersion } from "@/lib/services/mbos-service";

/**
 * POST /api/mbos/errors — what went wrong on a handset, sent by the handset.
 *
 * See `mbosClientErrors`. The phone keeps a short list of the errors it caught
 * and sends it here on the next sync; the answer tells it which ones are safe
 * to forget. Everything in the body is free text from a device, so every field
 * is trimmed and capped before it is stored — a stack trace is the one field
 * where "as long as it likes" would otherwise be the honest description.
 */

const MAX_PER_REQUEST = 20;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  let body: { errors?: unknown };
  try {
    body = (await request.json()) as { errors?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, code: "validation", error: "That was not readable JSON." },
      { status: 400 },
    );
  }

  const list = Array.isArray(body.errors) ? body.errors.slice(0, MAX_PER_REQUEST) : [];
  const { principal } = auth;
  const appVersion = reportedVersion(request);

  const rows = list.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const e = raw as Record<string, unknown>;
    const clientId = text(e.id, 80);
    const message = text(e.message, 2000);
    if (!clientId || !message) return [];
    const at = typeof e.at === "number" && Number.isFinite(e.at) ? new Date(e.at) : null;
    return [
      {
        id: randomUUID(),
        clientId,
        userId: principal.user.id,
        deviceId: principal.deviceId,
        appVersion,
        kind: text(e.kind, 20) ?? "error",
        message,
        stack: text(e.stack, 8000),
        screen: text(e.screen, 200),
        occurredAt: at && !Number.isNaN(at.getTime()) ? at : null,
      },
    ];
  });

  if (rows.length) {
    /* A list sent twice — the answer was lost after the insert — is stored
       once: the handset's own id is unique per device. */
    await db.insert(mbosClientErrors).values(rows).onConflictDoNothing();
  }

  /* Every id the phone sent is safe to forget, including any this refused as
     unreadable: keeping an unreadable entry would only send it again. */
  const received = list.flatMap((raw) =>
    raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? [(raw as { id: string }).id]
      : [],
  );
  return NextResponse.json({ ok: true, stored: rows.length, received });
}
