import "server-only";
import { headers } from "next/headers";
import type { DownloadApp, DownloadAppId } from "./apps";

/**
 * The version the release workflow last published beside an APK, read off
 * `/downloads/<name>.json` on this same host — the file lives on the droplet,
 * outside the app image, so it can only be reached the way a phone reaches it.
 * Null where there is none yet or it cannot be read: the page then simply
 * says nothing about a version, never a wrong one.
 */
export type Release = {
  version: string;
  /** A 32-bit build was published beside it (`url32` in the manifest). */
  has32Bit: boolean;
};

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<DownloadAppId, { at: number; release: Release | null }>();

export async function currentRelease(
  app: DownloadApp,
): Promise<Release | null> {
  const hit = cache.get(app.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.release;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  let release: Release | null = null;
  if (host && !host.startsWith("localhost") && !host.startsWith("127.")) {
    try {
      const r = await fetch(`https://${host}${app.manifest}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const body = (await r.json()) as { version?: unknown; url32?: unknown };
        if (
          typeof body.version === "string" &&
          /^[\w.+-]{1,32}$/.test(body.version)
        )
          release = {
            version: body.version,
            has32Bit: typeof body.url32 === "string" && body.url32.length > 0,
          };
      }
    } catch {
      /* Not published yet, or unreachable: no version is shown. */
    }
  }
  cache.set(app.id, { at: Date.now(), release });
  return release;
}

/** The public address of a page, for the QR a laptop visitor scans. */
export async function absoluteUrl(path: string): Promise<string> {
  const h = await headers();
  const host =
    h.get("x-forwarded-host") ?? h.get("host") ?? "one.mahekindia.com";
  const local = host.startsWith("localhost") || host.startsWith("127.");
  return `${local ? "http" : "https"}://${host}${path}`;
}
