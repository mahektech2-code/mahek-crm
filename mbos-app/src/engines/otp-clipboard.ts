/**
 * THE OTP, READ OFF THE CLIPBOARD.
 *
 * No app may read another app's WhatsApp messages, and MiniMoth sends the OTP
 * on WhatsApp first. What a salesman CAN do in one tap is copy it — WhatsApp's
 * own "Copy code" button, or a long-press on the message — and the sign-in
 * screen picks it up the moment he comes back to MBOS. This decides whether
 * what was copied is an OTP at all.
 *
 * Pure, because it is the whole rule: what to accept, and what to leave alone.
 *
 * - Exactly ONE run of six digits, standing alone. A copied message may carry
 *   other numbers ("valid for 10 minutes"), but two six-digit runs is a guess
 *   between them, and a wrong guess spends one of his tries.
 * - Never a code already tried: the clipboard still holds yesterday's code the
 *   next morning, and submitting it again would only be refused again.
 */
export const OTP_LENGTH = 6;

export function otpFromClipboard(text: string | null | undefined, alreadyTried: ReadonlySet<string>): string | null {
  if (!text) return null;
  /* Long enough to be a pasted message, short enough not to be a document. */
  if (text.length > 500) return null;
  const runs = text.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
  if (runs.length !== 1) return null;
  const code = runs[0];
  return alreadyTried.has(code) ? null : code;
}
