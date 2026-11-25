import "server-only";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";

/**
 * Whether a handset should draw the "scan a card" button on the New lead form.
 *
 * Sent on the pull as `mbos.ai.leadScan`, like `mbos.ai.visitAssistant`,
 * because a phone cannot ask a server whether it may offer a button while a
 * salesman stands in a doorway. The ANSWER crosses and nothing behind it — no
 * model name, no key. A model that can see is needed: OpenAI, or Sarvam's
 * Extract where `leadScan.provider` puts it first (`lead-scan-service.ts`).
 */
export async function leadScanAvailability(): Promise<{ available: boolean; maxImages: number }> {
  const config = await getConfig();
  const maxImages = config["leadScan.maxImages"];
  if (!config["leadScan.enabled"]) return { available: false, maxImages };
  /* OpenAI can always read; Sarvam only where it is chosen to read first —
     `leadScan.trial` alone never makes a scan button appear. */
  if (await readSecret("openai.apiKey")) return { available: true, maxImages };
  const sarvamReads = config["leadScan.provider"] === "sarvam" && Boolean(await readSecret("sarvam.apiKey"));
  return { available: sarvamReads, maxImages };
}
