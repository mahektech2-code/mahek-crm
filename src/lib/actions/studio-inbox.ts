"use server";

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db } from "@/db";
import { fileStorage } from "@/lib/storage";
import { IMAGE_MAX_BYTES } from "@/lib/studio/domain/inbox";
import { forwardRecipients, getForward } from "@/lib/studio/forward-service";
import { getRecipient } from "@/lib/studio/recipients";
import { whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { auditLog } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { recordActivity } from "@/lib/studio/timeline-service";
import { resolveStudioScope } from "@/lib/studio/scope";
import { err, ok, type Result } from "@/lib/result";
import { downloadFilename } from "@/lib/studio/domain/caption";
import { claimRefresh, conversationForNumber, markRead, posterTemplateConfig, sendPosterAsTemplate, sendPosterMessage, sendPreviewPosterMessage, sendTextMessage, syncFromKapso } from "@/lib/studio/inbox-service";
import { previewEnabled } from "@/lib/studio/inbox-preview";
import { isPreviewAsset } from "@/lib/studio/inbox-preview-assets";
import { renderRecipe } from "@/lib/studio/render-service";
import { getPoster, recipeOf } from "@/lib/studio/service";

/* ---------------------------------------------------------------------------
 * The WhatsApp Inbox's writes. A server action is a URL: each one re-checks
 * the grant, and a poster is re-read through the viewer's own scope — the page
 * is never trusted to say which poster may be sent.
 * ------------------------------------------------------------------------- */

const MODULE = "studio.inbox";
const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

async function guard() {
  const user = await requireUser();
  return (await canOpenModule(user.id, MODULE)) ? user : null;
}

async function audit(actorId: string, action: string, entityId: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({ id: newId("aud"), actorId, action, entityType: "studio_wa_conversation", entityId, afterState: (previewEnabled() ? { ...detail, localPreview: true } : detail) as never });
}

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function sendPreview(userId: string, conversationId: string, assetId: string, caption: string, clientKey: string): Promise<Result<{ messageId: string }>> {
  const r = await sendPreviewPosterMessage(userId, { conversationId: String(conversationId ?? ""), caption: String(caption ?? ""), clientKey, assetId });
  if (!r.ok) return err(r.error);
  await audit(userId, "studio.inbox.sent", conversationId, { kind: "preview-picture", assetId, messageId: r.data.messageId });
  return ok({ messageId: r.data.messageId });
}

export async function sendText(input: { conversationId: string; body: string; clientKey: string }): Promise<Result<{ messageId: string }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  if (!KEY_RE.test(input.clientKey ?? "")) return err("That message could not be sent. Reload the page and try again.");
  const { scope } = await resolveStudioScope();
  const r = await sendTextMessage(user.id, { conversationId: String(input.conversationId ?? ""), body: String(input.body ?? ""), clientKey: input.clientKey, scopeIds: scope.userIds, activity: { kind: "message", contentName: String(input.body ?? "").trim().slice(0, 60) || "Message", contentRefType: "message", mode: "inbox" } });
  if (!r.ok) return err(r.error);
  await audit(user.id, "studio.inbox.sent", input.conversationId, { kind: "text", messageId: r.data.messageId });
  return ok({ messageId: r.data.messageId });
}

export async function sendPoster(input: { conversationId: string; posterId: string; caption: string; clientKey: string }): Promise<Result<{ messageId: string }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  if (!KEY_RE.test(input.clientKey ?? "")) return err("That poster could not be sent. Reload the page and try again.");
  /* LOCAL PREVIEW: a generic sample picture goes into the in-memory sample chat only. */
  if (previewEnabled() && isPreviewAsset(input.posterId)) return sendPreview(user.id, input.conversationId, input.posterId, input.caption, input.clientKey);
  /* getPoster is the scope check: whoever may open this poster may send it, and nobody else. */
  const poster = await getPoster(String(input.posterId ?? ""));
  if (!poster || poster.removedAt) return err("That poster was not found.", "not_found");
  const drawn = await renderRecipe(recipeOf(poster), "jpeg");
  if (!drawn.ok) return err(drawn.error);
  const filename = downloadFilename(poster.templateId, poster.recipient.company, poster.language, drawn.data.format);
  const { scope } = await resolveStudioScope();
  const r = await sendPosterMessage(user.id, {
    scopeIds: scope.userIds,
    activity: { kind: "poster", contentName: `${poster.templateName} - ${poster.recipient.company}`.slice(0, 200), contentRefType: "poster", contentRefId: poster.id, mode: "inbox" },
    conversationId: String(input.conversationId ?? ""),
    caption: String(input.caption ?? ""),
    clientKey: input.clientKey,
    posterId: poster.id,
    image: drawn.data.image,
    mime: drawn.data.format === "jpeg" ? "image/jpeg" : "image/png",
    filename,
  });
  if (!r.ok) return err(r.error);
  await audit(user.id, "studio.inbox.sent", input.conversationId, { kind: "poster", posterId: poster.id, messageId: r.data.messageId });
  return ok({ messageId: r.data.messageId });
}

/** A poster sent as the approved template, for somebody who has not written in the last 24 hours. The chat appears in the Inbox. */
export async function sendPosterTemplate(input: { posterId: string; clientKey: string }): Promise<Result<{ conversationId: string }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  if (!KEY_RE.test(input.clientKey ?? "")) return err("That poster could not be sent. Reload the page and try again.");
  const poster = await getPoster(String(input.posterId ?? ""));
  if (!poster || poster.removedAt) return err("That poster was not found.", "not_found");
  if (!poster.customerId) return err("The record this poster was made for is gone, so there is nobody to send it to.", "not_found");
  const { scope } = await resolveStudioScope();
  const recipient = await getRecipient(scope.userIds, poster.customerId);
  if (!recipient) return err("That person is no longer in your book.", "not_found");
  if (!recipient.whatsappPhone) return err("There is no usable phone number on their record.");
  const drawn = await renderRecipe(recipeOf(poster), "jpeg");
  if (!drawn.ok) return err(drawn.error);
  const filename = downloadFilename(poster.templateId, poster.recipient.company, poster.language, drawn.data.format);
  const r = await sendPosterAsTemplate(user.id, {
    phone: recipient.whatsappPhone,
    values: { name: poster.recipient.contact ?? poster.recipient.company, company: poster.recipient.company, sender: poster.senderName ?? user.name },
    caption: "",
    clientKey: input.clientKey,
    posterId: poster.id,
    image: drawn.data.image,
    mime: drawn.data.format === "jpeg" ? "image/jpeg" : "image/png",
    filename,
    scopeIds: scope.userIds,
    activity: { kind: "image", contentName: poster.templateName, contentRefType: "poster", contentRefId: poster.id, mode: "inbox", recipient: { customerId: poster.customerId, name: poster.recipient.company } },
  });
  if (!r.ok) return err(r.error);
  await audit(user.id, "studio.inbox.sent", r.data.conversationId, { kind: "poster-template", posterId: poster.id, messageId: r.data.messageId });
  return ok({ conversationId: r.data.conversationId });
}

/** Whether a poster can be sent as a template at all: the setting is filled in. */
export async function posterTemplateReady(): Promise<boolean> {
  return Boolean(await posterTemplateConfig());
}

/** An uploaded picture as WhatsApp takes it: JPEG or PNG, re-encoded where it is a WebP or too large. Null where it cannot be prepared. */
async function pictureOf(forward: { sourceRef: string; format: string }): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
  let bytes: Uint8Array = new Uint8Array(await fileStorage.read(forward.sourceRef));
  let mime = forward.format === "png" ? "image/png" : "image/jpeg";
  let ext = forward.format === "png" ? "png" : "jpg";
  if (forward.format === "webp" || bytes.byteLength > IMAGE_MAX_BYTES) {
    try {
      bytes = new Uint8Array(await sharp(Buffer.from(bytes), { limitInputPixels: 36_000_000 }).rotate().jpeg({ quality: 88 }).toBuffer());
      mime = "image/jpeg";
      ext = "jpg";
    } catch {
      return null;
    }
  }
  return { bytes, mime, ext };
}

/** A picture uploaded in Upload & Bulk Forward, sent as it is — only its uploader may send it. WhatsApp takes JPEG and PNG for a picture, so a WebP is re-encoded. */
export async function sendForward(input: { conversationId: string; forwardId: string; caption: string; clientKey: string }): Promise<Result<{ messageId: string }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  if (!KEY_RE.test(input.clientKey ?? "")) return err("That picture could not be sent. Reload the page and try again.");
  if (previewEnabled() && isPreviewAsset(input.forwardId)) return sendPreview(user.id, input.conversationId, input.forwardId, input.caption, input.clientKey);
  if (!(await canOpenModule(user.id, "studio.forward"))) return err("You do not have Upload & Bulk Forward, so its pictures are not offered.", "not_permitted");
  const forward = await getForward(user.id, String(input.forwardId ?? ""));
  if (!forward) return err("That picture was not found.", "not_found");
  const pic = await pictureOf(forward);
  if (!pic) return err("That picture could not be prepared for WhatsApp.");
  const { bytes, mime, ext } = pic;
  const safe = forward.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "poster";
  const { scope } = await resolveStudioScope();
  const r = await sendPosterMessage(user.id, { scopeIds: scope.userIds, activity: { kind: "image", contentName: forward.title, contentRefType: "forward", contentRefId: forward.id, mode: "inbox" }, conversationId: String(input.conversationId ?? ""), caption: String(input.caption ?? ""), clientKey: input.clientKey, posterId: null, image: bytes, mime, filename: `${safe}.${ext}` });
  if (!r.ok) return err(r.error);
  await audit(user.id, "studio.inbox.sent", input.conversationId, { kind: "forward", forwardId: forward.id, messageId: r.data.messageId });
  return ok({ messageId: r.data.messageId });
}

export async function openConversation(conversationId: string): Promise<Result<null>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  const { scope } = await resolveStudioScope();
  await markRead(String(conversationId ?? ""), scope.userIds);
  return ok(null);
}

/**
 * Catches the shared inbox up from Kapso. It stores the whole company number's recent conversations, which is the same
 * thing the webhook does and which every READ then scopes to the viewer — so what it returns must say nothing about the
 * company: no conversation, thread or message counts, only whether it ran. The counts go to the audit row, for the
 * administrators who read that. A second press inside `REFRESH_MIN_SECONDS` does not call Kapso again.
 */
export async function refreshFromKapso(): Promise<Result<{ refreshed: boolean; retryAfterSeconds: number | null }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  const wait = await claimRefresh();
  if (wait > 0) return ok({ refreshed: false, retryAfterSeconds: wait }, `Refreshed a moment ago. Try again in ${wait} second${wait === 1 ? "" : "s"}.`);
  const r = await syncFromKapso();
  if (!r.ok) return err(r.error);
  await audit(user.id, "studio.inbox.synced", "company-number", r.data);
  return ok({ refreshed: true, retryAfterSeconds: null }, "Refreshed from Kapso.");
}

/* ------------------------------------------------------------------ bulk send of an uploaded poster */

export type ForwardOutcome = { recipientId: string; name: string; outcome: "sent" | "failed" | "skipped"; reason: string | null };

const NO_TEMPLATE = " Outside the 24-hour window a poster can only go as an approved WhatsApp template, and template sending is not set up in the Studio yet - nothing was sent.";

/**
 * Sends an uploaded poster, with the forward's caption, to every recipient on its
 * list through the company number - and says for EACH recipient what happened:
 * sent (Kapso took it), skipped (a safeguard or the 24-hour window stopped it,
 * with the reason) or failed (Kapso refused). Nothing is stored per recipient:
 * the answer is this live result, and each message appears in its own thread in
 * the Inbox. A recipient with no open window is never sent a free-form message.
 */
export async function sendForwardToRecipients(forwardId: string): Promise<Result<{ outcomes: ForwardOutcome[] }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  if (!(await canOpenModule(user.id, "studio.forward"))) return err("You do not have Upload & Bulk Forward, so its pictures are not offered.", "not_permitted");
  const forward = await getForward(user.id, String(forwardId ?? ""));
  if (!forward) return err("That picture was not found.", "not_found");
  if (forward.status !== "started") return err("Start the forward first, then send it.", "conflict");
  if (!(await whatsappServiceState()).active) return err("The founder has WhatsApp sending switched off, so nothing was sent.", "rule_violation");
  const pic = await pictureOf(forward);
  if (!pic) return err("That picture could not be prepared for WhatsApp.");
  const { scope } = await resolveStudioScope();
  const safe = forward.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "poster";
  const outcomes: ForwardOutcome[] = [];
  for (const row of (await forwardRecipients(forward.id)).slice(0, 50)) {
    const base = { recipientId: row.id, name: row.company };
    if (row.status === "sent" || row.status === "skipped") {
      outcomes.push({ ...base, outcome: "skipped", reason: row.status === "sent" ? "You already marked this one as sent." : "You skipped this one." });
      continue;
    }
    const notSent = async (reason: string, customerId: string | null) => {
      outcomes.push({ ...base, outcome: "skipped", reason });
      await recordActivity({ kind: "image", contentName: forward.title, contentRefType: "forward", contentRefId: forward.id, caption: forward.caption, senderId: user.id, customerId, recipientName: row.company, mode: "bulk", channel: "kapso", action: "not_sent", reason, batchRef: forward.id });
    };
    const target = row.customerId ? await getRecipient(scope.userIds, row.customerId) : null;
    if (!target) {
      await notSent("No longer in your book, so there is no number to send to.", null);
      continue;
    }
    const conv = await conversationForNumber(target.whatsappPhone, scope.userIds);
    if (!conv) {
      await notSent("They have not written to the company number, so there is no open WhatsApp window." + NO_TEMPLATE, target.id);
      continue;
    }
    const r = await sendPosterMessage(user.id, { scopeIds: scope.userIds, activity: { kind: "image", contentName: forward.title, contentRefType: "forward", contentRefId: forward.id, mode: "bulk", batchRef: forward.id, recipient: { customerId: target.id, name: row.company } }, conversationId: conv.id, caption: forward.caption, clientKey: `fwd-${row.id}`, posterId: null, image: pic.bytes, mime: pic.mime, filename: `${safe}.${pic.ext}` });
    if (r.ok) outcomes.push({ ...base, outcome: "sent", reason: null });
    else outcomes.push({ ...base, outcome: r.code === "rule_violation" || r.code === "not_found" ? "skipped" : "failed", reason: r.code === "rule_violation" && /24 hours/.test(r.error) ? r.error + NO_TEMPLATE : r.error });
  }
  if (!outcomes.length) return err("There is nobody on this list.", "not_found");
  return ok({ outcomes });
}
