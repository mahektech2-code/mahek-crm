/**
 * Runs once when a server starts. It only switches on the count of requests
 * to outside services (`lib/integration-usage.ts`), and only on the Node
 * runtime — the edge runtime has no diagnostics channel.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startUsageTracking } = await import("./lib/integration-usage");
  startUsageTracking();
}
