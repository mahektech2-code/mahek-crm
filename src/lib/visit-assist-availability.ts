import "server-only";
import { getConfig } from "@/lib/config/store";
import { structuredReadAvailable } from "@/lib/structured-read";

/**
 * Whether a handset should draw the visit assistant at all.
 *
 * Sent on the pull as `mbos.ai.visitAssistant`, like `mbos.ai.dictation`,
 * because a phone cannot ask a server whether it may offer a button. Its own
 * file rather than the service's, so the pull does not import the service
 * that imports the sync handlers that import the pull.
 */
export async function visitAssistAvailability(): Promise<{
  available: boolean;
}> {
  const config = await getConfig();
  if (!config["visitIntel.enabled"]) return { available: false };
  return { available: await structuredReadAvailable() };
}
