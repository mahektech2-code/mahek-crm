import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { dictationAvailability } from "@/lib/dictation-requests";

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
 *
 * MBOS asks the same question a different way. A handset spends its day
 * without signal, so it cannot ask an endpoint at the moment it draws a
 * screen — the same answer rides down on its pull instead and is read from
 * the local cache. Both come from `dictationAvailability`.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ available: false }, { status: 401 });

  const availability = await dictationAvailability();
  if (!availability.available) {
    return NextResponse.json({ available: false, reason: availability.reason });
  }

  const config = await getConfig();

  return NextResponse.json({
    ...availability,
    /*
     * How the microphone itself is opened. The browser's defaults are tuned
     * for a conference call and cost us quiet speech, so they are decided
     * here rather than left to it — and they are settings, because how loud a
     * calling floor is differs by floor and nobody should need a deploy to
     * find out which way suits theirs.
     *
     * Browser-only. A handset records through a recording preset rather than
     * a media-stream constraint, so these three mean nothing to MBOS and it
     * is not sent them.
     */
    capture: {
      noiseSuppression: config["voice.noiseSuppression"],
      autoGainControl: config["voice.autoGainControl"],
      echoCancellation: config["voice.echoCancellation"],
    },
  });
}
