"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { attachments, auditLog, hrmsNotifications } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { ADMIN } from "@/lib/admin-routes";
import {
  recomputeAllBuyingCycles,
  recomputeAllFollowUpStates,
  recomputeAllOutstanding,
  recomputeOrderSystemHolds,
  recomputeSlowPayers,
} from "@/lib/recompute";
import { fromThrown, ok, type Result } from "@/lib/result";
import { DERIVED_FIGURES, type DerivedFigure } from "@/lib/admin-derived";
import { readSecret } from "@/lib/secrets";
import { watiHealth } from "@/lib/wati";
import { setDocumentPublished } from "@/lib/actions/sales";
import { restoreAnnouncement } from "@/lib/services/announcement-service";
import { hrmsLink } from "@/lib/hrms/registry";

/* ---------------------------------------------------------------------------
 * Data health's rebuild buttons. Each is the matching function in
 * `lib/recompute.ts` — the one documented way to correct a derived figure —
 * run on demand rather than waiting for the nightly pass. Platform
 * administrators only, and every run is audited.
 * ------------------------------------------------------------------------- */

const RUN: Record<DerivedFigure, () => Promise<unknown>> = {
  outstanding: recomputeAllOutstanding,
  cycles: recomputeAllBuyingCycles,
  followUps: recomputeAllFollowUpStates,
  slowPayers: recomputeSlowPayers,
  orderHolds: recomputeOrderSystemHolds,
};

export async function rebuildDerived(which: DerivedFigure): Promise<Result<{ seconds: number }>> {
  try {
    const user = await requirePlatformAdminUser();
    if (!(which in RUN)) throw new Error("Not a derived figure");
    const started = Date.now();
    await RUN[which]();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    await db.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: user.id,
      action: "job.rebuild",
      entityType: "derived_figure",
      entityId: which,
      afterState: { seconds } as never,
    });
    try {
      revalidatePath(ADMIN.home, "layout");
    } catch {
      /* no request context */
    }
    const label = DERIVED_FIGURES.find((d) => d.id === which)?.label ?? which;
    return ok({ seconds }, `${label} rebuilt in ${seconds}s.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------------------------
 * TEST CONNECTION — one cheap, read-only request with the stored key, so
 * "is it connected" is answered by the provider rather than by a key merely
 * being present. Each test reads nothing the provider bills for. A provider
 * with no such request (Sarvam, MiniMoth) is not offered a test.
 * ------------------------------------------------------------------------- */

export type TestableProvider = "openai" | "anthropic" | "ola" | "wati" | "github" | "resend";

async function probe(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  return { ok: res.ok, status: res.status };
}

export async function testConnection(provider: TestableProvider): Promise<Result<{ ms: number }>> {
  try {
    await requirePlatformAdminUser();
    const started = Date.now();
    let r: { ok: boolean; status: number } | null = null;
    let missing = false;
    if (provider === "wati") {
      const h = await watiHealth();
      if (!h.ok) return { ok: false, error: h.error };
      r = { ok: true, status: 200 };
    } else if (provider === "resend") {
      const key = process.env.RESEND_API_KEY;
      if (!key) missing = true;
      else r = await probe("https://api.resend.com/domains", { Authorization: `Bearer ${key}` });
    } else {
      const name = ({ openai: "openai.apiKey", anthropic: "anthropic.apiKey", ola: "olamaps.apiKey", github: "github.token" } as const)[provider];
      const key = await readSecret(name);
      if (!key) missing = true;
      else if (provider === "openai") r = await probe("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` });
      else if (provider === "anthropic")
        r = await probe("https://api.anthropic.com/v1/models", { "x-api-key": key, "anthropic-version": "2023-06-01" });
      else if (provider === "ola")
        r = await probe(
          `https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json?api_key=${encodeURIComponent(key)}`,
          {},
        );
      else r = await probe("https://api.github.com/rate_limit", { Authorization: `Bearer ${key}`, "User-Agent": "MahekOne" });
    }
    if (missing) return { ok: false, error: "No key is set, so there is nothing to test." };
    const ms = Date.now() - started;
    if (!r?.ok)
      return {
        ok: false,
        error:
          r?.status === 401 || r?.status === 403
            ? "The provider refused the key. It is wrong, revoked or out of credit."
            : `The provider answered ${r?.status ?? "nothing"}.`,
      };
    return ok({ ms }, `Connected — answered in ${ms} ms.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------------------------
 * THE RECYCLE BIN'S RESTORES. Platform administrators only, each audited.
 * ------------------------------------------------------------------------- */

async function audit(actorId: string, action: string, entityType: string, entityId: string) {
  await db.insert(auditLog).values({ id: `aud_${randomUUID().slice(0, 12)}`, actorId, action, entityType, entityId });
}

function refresh() {
  try {
    revalidatePath(ADMIN.home, "layout");
  } catch {
    /* no request context */
  }
}

/** Puts a removed file back on the record it was taken off, while its bytes are still held. */
export async function restoreFile(id: string): Promise<Result<null>> {
  try {
    const user = await requirePlatformAdminUser();
    const [row] = await db
      .update(attachments)
      .set({
        status: "available",
        parentType: sql`${attachments.removedParentType}`,
        parentId: sql`${attachments.removedParentId}`,
        removedParentType: null,
        removedParentId: null,
        removedAt: null,
        updatedAt: new Date(),
      } as never)
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.status, "removed"),
          isNull(attachments.purgedAt),
          isNotNull(attachments.removedParentId),
        ),
      )
      .returning({ filename: attachments.filename });
    if (!row) return { ok: false, error: "That file can no longer be restored — its hold has run out." };
    await audit(user.id, "attachment.restore", "attachment", id);
    refresh();
    return ok(null, `${row.filename} is back on its record.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/** Publishes a withdrawn library document again, through the screen's own action. */
export async function restoreDocument(id: string): Promise<Result<null>> {
  try {
    await requirePlatformAdminUser();
    const r = await setDocumentPublished({ documentId: id, published: true });
    if (!r.ok) return r;
    refresh();
    return ok(null, r.message ?? "Published again.");
  } catch (e) {
    return fromThrown(e);
  }
}

/** Sends a deleted announcement again to the people it reached. */
export async function restoreAnnouncementAction(id: string): Promise<Result<null>> {
  try {
    const user = await requirePlatformAdminUser();
    const [n] = await db.select({ landing: hrmsNotifications.landing }).from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
    const r = await restoreAnnouncement(id, n?.landing ? hrmsLink(n.landing) : null);
    if (!r) return { ok: false, error: "That announcement is not in the bin any more." };
    await audit(user.id, "hrms.notification.restore", "hrms_notifications", id);
    refresh();
    return ok(null, `Announcement restored and sent again to ${r.reached} ${r.reached === 1 ? "person" : "people"}.`);
  } catch (e) {
    return fromThrown(e);
  }
}
