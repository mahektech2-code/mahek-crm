import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { voiceReadiness } from "@/lib/dictation";

/* ---------------------------------------------------------------------------
 * Whether to draw a microphone, and what it is allowed to do.
 *
 * The mic sits on twenty-odd boxes across four apps, most of them deep inside
 * client components that have no way to read configuration — `getConfig` is
 * server-only. Threading two numbers and a boolean down through every one of
 * those screens as props would mean editing all of them again the next time a
 * setting is added, so the button asks this once per page load instead and
 * caches the answer for the tab.
 *
 * The setting is checked here as well as in the interface. A hidden box is not
 * a disabled feature: /api/dictate/transcribe must refuse when dictation is
 * off, not merely be hard to reach.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ available: false }, { status: 401 });

  const config = await getConfig();

  /*
   * Two different reasons not to offer it, and they are worth telling apart in
   * the response even though the button draws nothing either way: "a manager
   * turned it off" is somebody's decision, "no credential" is a deploy that
   * was never finished, and only one of them should be chased.
   */
  if (!config["voice.enabled"]) {
    return NextResponse.json({ available: false, reason: "disabled" });
  }

  const ready = await voiceReadiness({
    provider: config["voice.transcriptionProvider"],
    fallbackToOpenai: config["voice.fallbackToOpenai"],
    maxSeconds: config["voice.maxSeconds"],
  });

  /* No key that the chosen provider can use, no microphone — rather than a
   * button that fails when pressed. */
  if (!ready.canHear) {
    return NextResponse.json({ available: false, reason: "not_configured" });
  }

  return NextResponse.json({
    available: true,
    /*
     * The EFFECTIVE limit, not the configured one. Where OpenAI has no key to
     * catch the long recordings, this is Sarvam's own 30-second ceiling, and
     * the recorder stops there — a limit that lets somebody talk for two
     * minutes into a provider that will refuse it is a promise the deployment
     * cannot keep.
     */
    maxSeconds: ready.maxSeconds,
    maxSizeMb: config["voice.maxSizeMb"],
    /*
     * Tighten and Rewrite are a text call and need OpenAI even where Sarvam
     * did the hearing. Told here so the modal can leave the buttons out
     * rather than offer two that fail.
     */
    canRefine: ready.canRefine,
  });
}
