/**
 * /.well-known/assetlinks.json (rewritten here by next.config.ts).
 *
 * Android opens the Factory app full screen — no browser bar — only if this
 * site vouches for the key the APK was signed with. That key's fingerprint is
 * known only where its password is: the release workflow
 * (.github/workflows/factory-apk.yml) computes it and publishes
 * /downloads/factory-assetlinks.json beside the APK. This reads that file
 * back, so a re-signed release needs no deploy.
 *
 * An empty list where there is none yet: the app then opens with a browser
 * bar, which is a cosmetic fallback, never a broken app.
 */
let cached: { at: number; body: string } | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function GET(request: Request) {
  if (cached && Date.now() - cached.at < TTL_MS) return answer(cached.body);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let body = "[]";
  if (host && !host.startsWith("localhost")) {
    try {
      const r = await fetch(`https://${host}/downloads/factory-assetlinks.json`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const text = await r.text();
        if (Array.isArray(JSON.parse(text))) body = text;
      }
    } catch {
      /* Not published yet, or unreachable: the empty list stands. */
    }
  }
  cached = { at: Date.now(), body };
  return answer(body);
}

const answer = (body: string) => new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
