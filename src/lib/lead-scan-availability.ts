import "server-only";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";

/**
 * Whether a handset should draw the "scan a card" button on the New lead form.
 *
 * Sent on the pull as `mbos.ai.leadScan`, like `mbos.ai.visitAssistant`,
 * because a phone cannot ask a server whether it may offer a button while a
 * salesman stands in a doorway. The ANSWER crosses and nothing behind it — no
 * model name, no key. OpenAI only: reading a photograph needs a model that can
 * see, and Sarvam's chat endpoint cannot (`lead-scan-service.ts`).
 */
export async function leadScanAvailability(): Promise<{ available: boolean; maxImages: number }> {
  const config = await getConfig();
  const maxImages = config["leadScan.maxImages"];
  if (!config["leadScan.enabled"]) return { available: false, maxImages };
  return { available: Boolean(await readSecret("openai.apiKey")), maxImages };
}
