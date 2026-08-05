import "server-only";

/* ---------------------------------------------------------------------------
 * The one place mail leaves MahekOne.
 *
 * There is no mail provider wired up yet, and pretending otherwise would be
 * worse than saying so: a reset link that silently goes nowhere looks exactly
 * like one the user's inbox ate. So delivery is explicit about which of the two
 * happened. Set RESEND_API_KEY and MAIL_FROM and it posts to Resend; without
 * them it writes the mail to the server log, which is what a local `npm run
 * dev` needs anyway.
 *
 * Swapping in a different provider means editing `deliver()` and nothing else.
 * ------------------------------------------------------------------------- */

export type Mail = {
  to: string;
  subject: string;
  text: string;
};

export type MailOutcome =
  /** The provider accepted it. */
  | { delivered: true }
  /** No provider configured — the mail was logged instead. */
  | { delivered: false; reason: "not_configured" }
  /** A provider is configured and refused it. */
  | { delivered: false; reason: "failed"; detail: string };

export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

export async function sendMail(mail: Mail): Promise<MailOutcome> {
  if (!mailConfigured()) {
    console.info(
      [
        "",
        "── MahekOne mail (no provider configured, not sent) ──",
        `To:      ${mail.to}`,
        `Subject: ${mail.subject}`,
        "",
        mail.text,
        "──────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return { delivered: false, reason: "not_configured" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error("Mail provider rejected the message:", res.status, detail);
      return { delivered: false, reason: "failed", detail };
    }
    return { delivered: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("Mail provider unreachable:", detail);
    return { delivered: false, reason: "failed", detail };
  }
}
