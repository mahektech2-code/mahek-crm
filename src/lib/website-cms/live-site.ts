import "server-only";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { websitePublishLog } from "@/db/schema";
import { readSecret } from "@/lib/secrets";
import { signPreviewToken } from "./preview-token";

/* ---------------------------------------------------------------------------
 * TALKING TO THE PUBLIC SITE — refreshing it after a publish, checking that it
 * is connected, and minting a preview link.
 *
 * The one rule this file exists to keep: A REFRESH THAT DID NOT HAPPEN IS NEVER
 * REPORTED AS ONE. A publish commits to MahekOne's database first; telling the
 * website to drop its cache is a second step that can fail (the site is down,
 * the secret differs, the site is not switched on). Each outcome is its own
 * answer, recorded in the publish log, and the screens say which it was:
 *
 *   refreshed      — the site answered 200 {ok:true}: the next visitor sees it
 *   failed         — the site was configured but did not confirm; the content
 *                    IS published here and will reach visitors when the site
 *                    next reads (within minutes) or on "Refresh the live site"
 *   not_configured — a secret is missing: nothing was sent, nothing changed live
 * ------------------------------------------------------------------------- */

export type LiveStatus = "refreshed" | "failed" | "not_configured";
export type LiveRefresh = { status: LiveStatus; detail: string; at: string };

const TIMEOUT_MS = 8000;

/** Base of the website's CMS endpoints, e.g. `http://website:3000/api/cms`. Read per call so tests and deploys can change it. */
export function websiteCmsBase(): string {
  return (process.env.WEBSITE_REVALIDATE_URL?.trim() || "http://website:3000/api/cms").replace(/\/+$/, "");
}

export function websitePublicUrl(): string {
  return (process.env.WEBSITE_PUBLIC_URL?.trim() || "https://mahekindia.com").replace(/\/+$/, "");
}

async function logRefresh(actorId: string | null, ok: boolean, detail: string, reason: string) {
  await db.insert(websitePublishLog).values({
    id: `wl_${randomUUID().slice(0, 12)}`,
    actorId,
    action: "refresh",
    ok,
    detail: `${reason}: ${detail}`.slice(0, 500),
  });
}

/** Tells the public site to drop its cached content so the next request re-reads it. */
export async function refreshLiveSite(actorId: string | null, reason: string): Promise<LiveRefresh> {
  const at = new Date().toISOString();
  const secret = await readSecret("website.cmsPublishSecret");
  if (!secret) {
    const detail = "The website publish secret is not set (Admin → Integrations), so the live site was not told to refresh.";
    await logRefresh(actorId, false, detail, reason);
    return { status: "not_configured", detail, at };
  }

  try {
    const response = await fetch(`${websiteCmsBase()}/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.ok) {
      const body: unknown = await response.json().catch(() => null);
      // 200 alone is not enough: a proxy or the wrong service can answer 200.
      if (body && typeof body === "object" && (body as { ok?: unknown }).ok === true) {
        await logRefresh(actorId, true, "The live site confirmed the refresh.", reason);
        return { status: "refreshed", detail: "The live site confirmed the refresh.", at };
      }
      const detail = "The live site answered but did not confirm the refresh.";
      await logRefresh(actorId, false, detail, reason);
      return { status: "failed", detail, at };
    }
    const detail =
      response.status === 401
        ? "The live site refused the publish secret — it does not match CMS_PUBLISH_SECRET on the website."
        : response.status === 503
          ? "The live site is not switched on for the CMS (CMS_ENABLED / secrets are not set on the website)."
          : `The live site answered ${response.status}.`;
    await logRefresh(actorId, false, detail, reason);
    return { status: "failed", detail, at };
  } catch (e) {
    const detail =
      e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
        ? `The live site did not answer within ${TIMEOUT_MS / 1000} seconds.`
        : "The live site could not be reached.";
    await logRefresh(actorId, false, detail, reason);
    return { status: "failed", detail, at };
  }
}

export type ConnectionCheck =
  | { state: "not_configured"; detail: string }
  | { state: "unreachable"; detail: string }
  | { state: "ok"; enabled: boolean; cmsReachable: boolean; usingFallback: boolean; revision: string | null; detail: string };

/** A real read through the website's own status endpoint — not a guess from configuration. */
export async function checkLiveSite(): Promise<ConnectionCheck> {
  const [publishSecret, readSecret_] = await Promise.all([readSecret("website.cmsPublishSecret"), readSecret("website.cmsReadSecret")]);
  if (!publishSecret || !readSecret_) {
    return {
      state: "not_configured",
      detail: "The website read and publish secrets are not both set (Admin → Integrations).",
    };
  }
  try {
    const response = await fetch(`${websiteCmsBase()}/status`, {
      headers: { authorization: `Bearer ${publishSecret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        state: "unreachable",
        detail:
          response.status === 401
            ? "The live site refused the publish secret — it does not match CMS_PUBLISH_SECRET on the website."
            : response.status === 503
              ? "The live site is not switched on for the CMS yet."
              : `The live site answered ${response.status}.`,
      };
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      enabled?: boolean;
      cmsReachable?: boolean;
      usingFallback?: boolean;
      revision?: string | null;
    } | null;
    if (!body || body.ok !== true) return { state: "unreachable", detail: "The live site answered but not in the expected form." };
    const enabled = body.enabled === true;
    const cmsReachable = body.cmsReachable === true;
    const usingFallback = body.usingFallback !== false;
    return {
      state: "ok",
      enabled,
      cmsReachable,
      usingFallback,
      revision: typeof body.revision === "string" ? body.revision : null,
      detail: !enabled
        ? "The live site is up but is not switched on for the CMS — it is still showing the content built into it."
        : !cmsReachable
          ? "The live site is switched on but could not read content from MahekOne — it is showing its built-in content."
          : "The live site is reading its content from MahekOne.",
    };
  } catch {
    return { state: "unreachable", detail: "The live site could not be reached." };
  }
}

/** A short-lived link that opens the real public page showing the WORKING copy. `null` where previews cannot work. */
export async function previewLink(path: string): Promise<{ url: string } | { error: string }> {
  const secret = await readSecret("website.cmsPublishSecret");
  if (!secret) {
    return { error: "Previews need the website publish secret (Admin → Integrations) and the live site switched on for the CMS." };
  }
  const safePath = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  const token = signPreviewToken(secret, { path: safePath });
  const url = `${websitePublicUrl()}/api/cms/preview?token=${encodeURIComponent(token)}&path=${encodeURIComponent(safePath)}`;
  return { url };
}

/** The most recent refresh attempt, for the dashboard. */
export async function lastRefresh(): Promise<{ ok: boolean; at: string; detail: string | null } | null> {
  const [row] = await db
    .select({ ok: websitePublishLog.ok, at: websitePublishLog.at, detail: websitePublishLog.detail })
    .from(websitePublishLog)
    .where(eq(websitePublishLog.action, "refresh"))
    .orderBy(desc(websitePublishLog.at))
    .limit(1);
  return row ? { ok: row.ok, at: row.at.toISOString(), detail: row.detail } : null;
}
