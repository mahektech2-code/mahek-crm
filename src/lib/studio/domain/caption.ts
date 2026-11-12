import { posterName, type Lead, type User } from "./lead";
import type { Recipient } from "./recipient";
import { firstWord } from "./text";

// The suggested message that goes with a creative when it is sent (shown on the preview with a Copy
// button). One short, polite message per template category, using only the lead's first name, the
// product name and the salesperson. No prices, offers or claims, like the wording on the creative.

export type TemplateCategory = "festival" | "promotion" | "greeting" | "relationship" | "repeat";

const SIGNATURE = "Mahek Marketing India";

// The lead messages. `relationship` and `repeat` designs are customer-only and never offered to a lead
// (the template validator forbids it), so they share the plain greeting here only to keep the switch total.
export function suggestedCaption(category: TemplateCategory, lead: Pick<Lead, "contact" | "company" | "product">, user: Pick<User, "name" | "displayName">): string {
  const to = lead.contact ? firstWord(lead.contact) : lead.company;
  const who = posterName(user);
  const dash = who === null ? "" : `\n— ${who}`;
  const comma = who === null ? "" : `\n— ${who}, `;
  switch (category) {
    case "festival":
      return `Dear ${to}, warm wishes from all of us at ${SIGNATURE}.${dash || `\n— ${SIGNATURE}`}`;
    case "promotion":
      return `Hello ${to}, sharing a note on ${lead.product?.name ?? "our range"}. Happy to answer any questions.${comma}${SIGNATURE}`;
    case "greeting":
    case "relationship":
    case "repeat":
      return `Hello ${to}, thank you for your interest in Mahek. We are here to help.${comma}${SIGNATURE}`;
  }
}

/**
 * The message that goes with a CUSTOMER creative, or null when there is no approved message for that
 * kind of design yet. Festival wishes and product promotion read the same for a customer as for a
 * lead (they hold no enquiry language). The lead welcome is never for a customer. The relationship
 * and repeat-business messages are new customer wording: COPY REQUIRES APPROVAL, so none is written
 * here and the preview simply shows no suggested message for those designs.
 */
export function customerCaption(category: TemplateCategory, customer: Pick<Recipient, "contact" | "company" | "product">, user: Pick<User, "name" | "displayName">): string | null {
  switch (category) {
    case "festival":
    case "promotion":
      return suggestedCaption(category, customer, user);
    case "greeting":
    case "relationship":
    case "repeat":
      return null;
  }
}

/** The WhatsApp link that opens a chat picker with the message ready. It cannot attach an image. */
export function whatsappTextUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

const slug = (s: string, max: number) =>
  s
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");

/**
 * A safe, readable download name such as "Mahek_diwali-premium_ABC-Industries_hi.png". Only plain
 * ASCII letters, digits, dot, dash and underscore survive, so the name works on every system and
 * can never carry a path or a header-breaking character.
 */
export function downloadFilename(templateId: string, company: string, language: string, format: "png" | "jpeg", options: { sample?: boolean } = {}): string {
  const who = slug(company, 24) || "lead";
  // a poster made from sample data says so in its file name too (the server decides, see generation/service.ts)
  const prefix = options.sample === true ? "SAMPLE_" : "";
  return `${prefix}Mahek_${slug(templateId, 40) || "creative"}_${who}_${slug(language, 4) || "en"}.${format === "jpeg" ? "jpg" : "png"}`;
}
