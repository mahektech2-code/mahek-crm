import "server-only";
import { getConfig } from "@/lib/config/store";
import { structuredReadAvailable } from "@/lib/structured-read";

/**
 * Whether a handset should offer "Speak about the shop" on the New lead form.
 *
 * Sent on the pull as `mbos.ai.leadVoice`, like `mbos.ai.leadScan`, because a
 * phone cannot ask a server whether it may draw a button while a salesman
 * stands in a doorway. The ANSWER crosses and nothing behind it — no model
 * name, no key. Either model will do: reading words needs no eyes, so a
 * Sarvam-only deployment gets it too. The handset also needs dictation to be
 * available before it draws the button, and reads that answer itself.
 */
export async function leadVoiceAvailability(): Promise<{ available: boolean }> {
  const config = await getConfig();
  if (!config["leadVoice.enabled"]) return { available: false };
  return { available: await structuredReadAvailable() };
}
