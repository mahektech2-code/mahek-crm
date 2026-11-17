/**
 * The outside services MahekOne calls, and the hosts that are each one.
 *
 * Pure and client-safe: the usage counter matches a request's host against
 * this list, and Integrations names each provider from it.
 */
export const INTEGRATION_PROVIDERS = [
  { id: "openai", name: "OpenAI", hosts: ["api.openai.com"] },
  { id: "anthropic", name: "Anthropic", hosts: ["api.anthropic.com"] },
  { id: "sarvam", name: "Sarvam", hosts: ["api.sarvam.ai"] },
  { id: "ola", name: "Ola Maps", hosts: ["api.olamaps.io"] },
  { id: "wati", name: "Wati · WhatsApp", hosts: ["wati.io"] },
  { id: "minimoth", name: "MiniMoth · codes", hosts: ["minimoth.dev"] },
  { id: "resend", name: "Resend · mail", hosts: ["api.resend.com"] },
  { id: "github", name: "GitHub", hosts: ["api.github.com"] },
  { id: "google", name: "Google Sheets", hosts: ["sheets.googleapis.com", "oauth2.googleapis.com"] },
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]["id"];

/** Which provider a host belongs to — the host itself or any subdomain of a listed one. */
export function providerForHost(host: string): IntegrationProvider | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  for (const p of INTEGRATION_PROVIDERS) {
    if (p.hosts.some((x) => h === x || h.endsWith(`.${x}`))) return p.id;
  }
  return null;
}
