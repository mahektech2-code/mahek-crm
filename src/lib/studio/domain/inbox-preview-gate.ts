/**
 * THE LOCAL PREVIEW GATE — pure.
 *
 * The WhatsApp Inbox can show clearly labelled SAMPLE conversations so the
 * screen can be inspected before the company number is connected. That is for
 * a developer's machine only, so it needs ALL of these at once:
 *   - never when NODE_ENV is production (a deployed build);
 *   - only when somebody has asked for it with STUDIO_INBOX_PREVIEW=1;
 *   - only when the database is on this machine (localhost / 127.0.0.1 / ::1)
 *     and is one of MahekOne's own local databases (named mahekone, mahekone_…).
 * Anything else — a shared host, an unparseable URL, a differently named
 * database — answers false, so a stray variable can never put sample data in
 * front of the team.
 */
export type PreviewEnv = { NODE_ENV?: string; STUDIO_INBOX_PREVIEW?: string; DATABASE_URL?: string };

export function previewAllowed(env: PreviewEnv): boolean {
  if (env.NODE_ENV === "production") return false;
  if (env.STUDIO_INBOX_PREVIEW !== "1") return false;
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    return false;
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase())) return false;
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return /^mahekone(_|$)/.test(name);
}
