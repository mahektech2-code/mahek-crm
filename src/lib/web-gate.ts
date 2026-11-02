import type { LeadGateInput } from "@/lib/engines/lead-gates";

/**
 * THE WEB CRM MOVES A PROSPECT INTO QUALIFICATION BY HAND, with no prior
 * confirmation. The shared gate engine (mirrored onto the handset, so not edited
 * here) still asks for the Prospect to be verified before "qualification"; the
 * Web CRM answers that one question on the lead's behalf, for this one move.
 * Review of the answers is the mandatory Qualification Review that comes after,
 * and the Verification Call stays optional. MBOS callers never pass through here.
 */
/** What the web answers for "verified" when only the entry-to-Qualification question is being asked. */
export const WEB_ENTRY_VERIFIED = new Date(0);

export function forWebQualificationEntry(gate: LeadGateInput): LeadGateInput {
  return gate.verifiedAt ? gate : { ...gate, verifiedAt: WEB_ENTRY_VERIFIED };
}
