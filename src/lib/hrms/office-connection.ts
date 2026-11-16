import "server-only";
import { clientAddress } from "@/lib/services/sign-in-throttle";
import { onOfficeNetwork } from "./engines/office-network";

/**
 * Whether THIS request comes from the office's own internet connection. The
 * address is Caddy's, never the browser's say-so (see `clientAddress`). Null
 * outside a request and in development, where nothing sets it — so locally a
 * punch-in is always judged on location, exactly as before.
 */
export async function onOfficeConnection(office: { networkIps: string[] | null } | null | undefined): Promise<{ on: boolean; ip: string | null }> {
  const ip = await clientAddress();
  return { on: onOfficeNetwork(ip, office?.networkIps), ip };
}

/** "Your computer can only guess…" — said under an "outside" refusal where the guess was too rough to judge. */
export function roughFixNote(accuracyM: number | null | undefined, radiusM: number, hasNetwork: boolean): string {
  if (accuracyM == null || accuracyM <= radiusM) return "";
  const rough = accuracyM >= 1000 ? `${(accuracyM / 1000).toFixed(1)} km` : `${Math.round(accuracyM)} m`;
  return ` Your device could only place itself to within about ${rough}, which happens on a computer with no GPS. ${
    hasNetwork ? "Connect to the office Wi-Fi and try again, or punch in from your phone." : "Punch in from your phone, or ask HR to add the office's internet connection on the Offices screen."
  }`;
}
