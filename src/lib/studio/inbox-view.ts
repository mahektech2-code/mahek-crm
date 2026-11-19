import type { Connection } from "./inbox-service";

/** What the screen is told about the connection — never an id of Kapso's, and never a key. */
export type PublicConnection =
  | { state: "preview" }
  | { state: "no_key" }
  | { state: "rejected" | "unreachable"; error: string }
  | { state: "not_connected"; reason: "number_missing" | "sandbox_only"; expected: string; seen: { display: string | null; sandbox: boolean }[] }
  | { state: "connected"; display: string | null; coexistence: boolean | null; status: string | null; webhookSecretHeld: boolean };

export function publicConnection(c: Connection): PublicConnection {
  if (c.state === "preview") return { state: "preview" };
  if (c.state === "connected") return { state: "connected", display: c.display, coexistence: c.coexistence, status: c.status, webhookSecretHeld: c.webhookSecretHeld };
  return c;
}
