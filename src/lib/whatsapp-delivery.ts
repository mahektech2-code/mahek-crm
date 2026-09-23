/* ---------------------------------------------------------------------------
 * How a WhatsApp message leaves MahekOne — the rules, and nothing that does I/O.
 *
 * PURE AND CLIENT-SAFE, like `account-types` and `customer-health` beside it,
 * because the screens that draw "Send" or "Copy" and the service that actually
 * sends have to agree about which one a message gets, and a second copy of the
 * rule typed into a screen drifts within a release.
 *
 * TWO ROUTES, AND THE MANUAL ONE NEVER GOES AWAY. The API route is an
 * improvement on copy-paste-confirm, not a replacement for it: a group cannot
 * be reached through the API at all, an edited message is no longer the text
 * Meta approved, and the whole service is off until the founder switches it
 * on. Every one of those falls back to the manual flow with the reason said,
 * so a telecaller is never left with a message and no way to send it.
 * ------------------------------------------------------------------------- */

export type DeliveryInput = {
  /** The founder's switch. Off means nothing goes through the API, whatever else is true. */
  serviceOn: boolean;
  /** Whether a Wati key is configured at all. */
  hasToken: boolean;
  destKind: "personal" | "group";
  /** The approved Wati template this CRM template is sent as, if anybody linked one. */
  watiTemplateName: string | null | undefined;
  /** A body the telecaller rewrote is not the text Meta approved. */
  edited: boolean;
};

export type DeliveryRoute =
  | { via: "api" }
  | { via: "manual"; why: string };

export function deliveryRoute(input: DeliveryInput): DeliveryRoute {
  if (!input.serviceOn) {
    return { via: "manual", why: "WhatsApp sending is switched off on the Founder Dashboard." };
  }
  if (!input.hasToken) {
    return { via: "manual", why: "No Wati key is configured, so nothing can go through the API." };
  }
  if (input.destKind === "group") {
    return { via: "manual", why: "A customer group cannot be reached through the API — paste it into the group." };
  }
  if (!input.watiTemplateName) {
    return { via: "manual", why: "This template is not linked to an approved Wati template yet." };
  }
  if (input.edited) {
    return { via: "manual", why: "An edited message is no longer the approved wording, so it goes the manual way." };
  }
  return { via: "api" };
}

/**
 * A number as WhatsApp wants it: country code, digits only, no plus. Null for
 * anything that is not recognisably an Indian mobile — sending to a guess is
 * how a payment reminder reaches a stranger.
 */
export function waNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  if (d.length !== 12 || !d.startsWith("91")) return null;
  // Indian mobiles start 6–9. A landline cannot receive WhatsApp.
  if (!/^91[6-9]\d{9}$/.test(d)) return null;
  return d;
}

/**
 * Wati's own parameter names mapped onto MahekOne's merge fields.
 *
 * A template written in Wati with `{{customer}}` and `{{outstanding}}` needs no
 * mapping at all — the names are the same. `name` is the one alias, because it
 * is the variable Wati itself suggests for the contact's name and somebody
 * writing a template there will reach for it first.
 */
const ALIASES: Record<string, string> = { name: "customer" };

export type ParamResolution = {
  params: Array<{ name: string; value: string }>;
  /** Parameters the template needs that this customer has no value for. */
  missing: string[];
  /** Parameters the template needs that MahekOne has no field for at all. */
  unknown: string[];
};

export function resolveWatiParams(
  paramNames: readonly string[],
  values: Record<string, string>,
  knownFields: readonly string[],
): ParamResolution {
  const params: Array<{ name: string; value: string }> = [];
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const name of paramNames) {
    const field = ALIASES[name] ?? name;
    if (!knownFields.includes(field)) {
      unknown.push(name);
      continue;
    }
    const value = flattenForTemplate(values[field] ?? "");
    if (!value) missing.push(name);
    else params.push({ name, value });
  }
  return { params, missing, unknown };
}

/**
 * A template parameter may not carry a newline, a tab or four spaces in a row —
 * Meta refuses the whole message. `{{bills_list}}` is one bill per line, so it
 * is joined with a separator a reader can still follow.
 */
export function flattenForTemplate(value: string): string {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" | ")
    .replace(/\t/g, " ")
    .replace(/ {4,}/g, "   ");
}

/* ------------------------------------------------------------ the webhooks */

export type WatiEvent =
  | { kind: "sent" | "delivered" | "read"; localMessageId: string; providerRef: string | null }
  | { kind: "failed"; localMessageId: string; providerRef: string | null; reason: string }
  | {
      kind: "reply";
      providerMessageId: string;
      waId: string;
      senderName: string | null;
      text: string;
    }
  | { kind: "ignored"; why: string };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * One Wati webhook body, read into the only facts MahekOne acts on.
 *
 * Wati names its events with version suffixes (`sentMessageDELIVERED_v2`,
 * `templateMessageSent_v2_bsuid`), so the match is on the stem rather than the
 * exact string: a new suffix is the same event, and refusing it would silently
 * stop delivery ticks the day Wati renamed one.
 */
export function parseWatiEvent(body: unknown): WatiEvent {
  if (!body || typeof body !== "object") return { kind: "ignored", why: "not an object" };
  const b = body as Record<string, unknown>;
  const type = (str(b.eventType) ?? "").toLowerCase();
  const local = str(b.localMessageId);
  const ref = str(b.whatsappMessageId);

  const incoming =
    type === "message" || type.startsWith("message_") || type.startsWith("newcontactmessage");
  if (incoming) {
    // An incoming message. `owner: true` is one WE sent, echoed back.
    if (b.owner === true) return { kind: "ignored", why: "our own message echoed" };
    const waId = str(b.waId);
    const id = ref ?? str(b.id);
    if (!waId || !id) return { kind: "ignored", why: "reply without a sender or id" };
    const text =
      str(b.text) ??
      str((b.buttonReply as Record<string, unknown> | null)?.text) ??
      str((b.listReply as Record<string, unknown> | null)?.title) ??
      `[${str(b.type) ?? "message"}]`;
    return { kind: "reply", providerMessageId: id, waId, senderName: str(b.senderName), text };
  }

  if (!local) return { kind: "ignored", why: `${type || "unknown"} without a localMessageId` };

  // A reply is also delivered as its own `message` event, which is the one
  // acted on; the "replied" status tick carries nothing that one does not.
  if (type.includes("replied")) return { kind: "ignored", why: "reply tick" };
  if (type.includes("failed")) {
    const detail = [str(b.failedCode), str(b.failedDetail)].filter(Boolean).join(" — ");
    return { kind: "failed", localMessageId: local, providerRef: ref, reason: detail || "Wati reported the message failed." };
  }
  if (type.includes("read")) return { kind: "read", localMessageId: local, providerRef: ref };
  if (type.includes("delivered")) return { kind: "delivered", localMessageId: local, providerRef: ref };
  if (type.includes("sent")) return { kind: "sent", localMessageId: local, providerRef: ref };
  return { kind: "ignored", why: `unhandled event ${type}` };
}

/**
 * Status only moves FORWARD. Webhooks arrive out of order — a read receipt
 * can beat the delivery tick — and a late "delivered" must not demote a
 * message somebody has already read. Failed is the exception: it can land on
 * a message we had recorded as sent, because the send was only ever Wati
 * accepting it, never WhatsApp delivering it.
 */
const RANK: Record<string, number> = { queued: 1, sent: 2, delivered: 3, read: 4 };

export function advancedStatus(
  current: string,
  event: "sent" | "delivered" | "read" | "failed",
): string | null {
  if (event === "failed") {
    return current === "delivered" || current === "read" ? null : "failed";
  }
  if (current === "failed" || current === "cancelled" || current === "sent_manually") return null;
  const from = RANK[current] ?? 0;
  return RANK[event] > from ? event : null;
}
