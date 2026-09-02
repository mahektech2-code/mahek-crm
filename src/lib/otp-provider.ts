import "server-only";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";

/* ---------------------------------------------------------------------------
 * The one place a sign-in code leaves MahekOne.
 *
 * Same shape as `mailer.ts`: a code with nowhere configured to send it is
 * worse pretending it went than saying plainly that it did not, so without
 * MSG91_AUTH_KEY (or an `app_secrets` row for it) the code is written to the
 * server log — which is what a local `npm run dev` needs anyway, and what
 * lets this whole feature be built and tried before anybody has opened an
 * MSG91 account.
 *
 * MSG91 rather than Twilio: an Indian provider built for exactly this pairing
 * of SMS and WhatsApp OTPs, and TRAI's DLT registration for commercial SMS in
 * India is far less friction through them than through a global provider. The
 * sender ID and DLT template for SMS, and the template/namespace/business
 * number for WhatsApp, are `auth.otp.*` settings rather than constants here —
 * none of them exist until the MSG91 account and its templates are approved,
 * which happens outside this codebase.
 *
 * Swapping in a different provider means editing `deliverSms` and
 * `deliverWhatsapp` and nothing else — `sendOtpCode` and every caller stay
 * the same.
 * ------------------------------------------------------------------------- */

export type OtpChannel = "sms" | "whatsapp";

export type OtpSendOutcome =
  /** The provider accepted it. */
  | { delivered: true }
  /** No provider configured — the code was logged instead. */
  | { delivered: false; reason: "not_configured" }
  /** A provider is configured but a setting it needs is still blank. */
  | { delivered: false; reason: "not_ready"; detail: string }
  /** A provider is configured and refused it. */
  | { delivered: false; reason: "failed"; detail: string };

export async function otpProviderConfigured(): Promise<boolean> {
  return Boolean(await readSecret("msg91.authKey"));
}

function logInsteadOfSending(phone: string, channel: OtpChannel, code: string) {
  console.info(
    [
      "",
      `── MahekOne OTP (no provider configured, not sent — ${channel}) ──`,
      `To:   ${phone}`,
      `Code: ${code}`,
      "─────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

/** The one function every sign-in code goes out through. */
export async function sendOtpCode(
  phone: string,
  channel: OtpChannel,
  code: string,
): Promise<OtpSendOutcome> {
  const authKey = await readSecret("msg91.authKey");
  if (!authKey) {
    logInsteadOfSending(phone, channel, code);
    return { delivered: false, reason: "not_configured" };
  }

  const config = await getConfig();
  const mobile = `91${phone}`;

  try {
    return channel === "sms"
      ? await deliverSms(authKey, mobile, code, config)
      : await deliverWhatsapp(authKey, mobile, code, config);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("OTP provider unreachable:", detail);
    return { delivered: false, reason: "failed", detail };
  }
}

async function deliverSms(
  authKey: string,
  mobile: string,
  code: string,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<OtpSendOutcome> {
  const templateId = config["auth.otp.smsTemplateId"];
  if (!templateId) {
    return {
      delivered: false,
      reason: "not_ready",
      detail: "No DLT-approved SMS template is set (auth.otp.smsTemplateId).",
    };
  }

  const url = new URL("https://control.msg91.com/api/v5/otp");
  url.searchParams.set("template_id", templateId);
  url.searchParams.set("mobile", mobile);
  url.searchParams.set("otp", code);
  url.searchParams.set("otp_length", String(config["auth.otp.codeLength"]));
  url.searchParams.set("otp_expiry", String(config["auth.otp.ttlMinutes"]));
  if (config["auth.otp.smsSenderId"]) {
    url.searchParams.set("sender", config["auth.otp.smsSenderId"]);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { authkey: authKey },
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("SMS OTP provider rejected the message:", res.status, detail);
    return { delivered: false, reason: "failed", detail };
  }
  return { delivered: true };
}

async function deliverWhatsapp(
  authKey: string,
  mobile: string,
  code: string,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<OtpSendOutcome> {
  const integratedNumber = config["auth.otp.whatsappIntegratedNumber"];
  const templateName = config["auth.otp.whatsappTemplateName"];
  const namespace = config["auth.otp.whatsappTemplateNamespace"];
  const missing = [
    !integratedNumber && "auth.otp.whatsappIntegratedNumber",
    !templateName && "auth.otp.whatsappTemplateName",
    !namespace && "auth.otp.whatsappTemplateNamespace",
  ].filter(Boolean);
  if (missing.length) {
    return {
      delivered: false,
      reason: "not_ready",
      detail: `WhatsApp OTP is missing: ${missing.join(", ")}.`,
    };
  }

  const res = await fetch(
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
    {
      method: "POST",
      headers: { Authkey: authKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        integrated_number: integratedNumber,
        content_type: "template",
        payload: {
          messaging_product: "whatsapp",
          type: "template",
          template: {
            name: templateName,
            language: {
              code: config["auth.otp.whatsappTemplateLanguage"],
              policy: "deterministic",
            },
            namespace,
            to_and_components: [
              {
                to: [mobile],
                components: { body_1: { type: "text", value: code } },
              },
            ],
          },
        },
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    console.error("WhatsApp OTP provider rejected the message:", res.status, detail);
    return { delivered: false, reason: "failed", detail };
  }
  return { delivered: true };
}
