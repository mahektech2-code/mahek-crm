"use server";

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db } from "@/db";
import { fileStorage } from "@/lib/storage";
import { IMAGE_MAX_BYTES } from "@/lib/studio/domain/inbox";
import { getForward } from "@/lib/studio/forward-service";
import { auditLog } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { err, ok, type Result } from "@/lib/result";
import { downloadFilename } from "@/lib/studio/domain/caption";
import { markRead, sendPosterMessage, sendPreviewPosterMessage, sendTextMessage, syncFromKapso } from "@/lib/studio/inbox-service";
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
  const r = await sendTextMessage(user.id, { conversationId: String(input.conversationId ?? ""), body: String(input.body ?? ""), clientKey: input.clientKey });
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
  const r = await sendPosterMessage(user.id, {
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

/** A picture uploaded in Upload & Bulk Forward, sent as it is — only its uploader may send it. WhatsApp takes JPEG and PNG for a picture, so a WebP is re-encoded. */
export async function sendForward(input: { conversationId: string; forwardId: string; caption: string; clientKey: string }): Promise<Result<{ messageId: string }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  if (!KEY_RE.test(input.clientKey ?? "")) return err("That picture could not be sent. Reload the page and try again.");
  if (previewEnabled() && isPreviewAsset(input.forwardId)) return sendPreview(user.id, input.conversationId, input.forwardId, input.caption, input.clientKey);
  if (!(await canOpenModule(user.id, "studio.forward"))) return err("You do not have Upload & Bulk Forward, so its pictures are not offered.", "not_permitted");
  const forward = await getForward(user.id, String(input.forwardId ?? ""));
  if (!forward) return err("That picture was not found.", "not_found");
  let bytes: Uint8Array = new Uint8Array(await fileStorage.read(forward.sourceRef));
  let mime = forward.format === "png" ? "image/png" : "image/jpeg";
  let ext = forward.format === "png" ? "png" : "jpg";
  if (forward.format === "webp" || bytes.byteLength > IMAGE_MAX_BYTES) {
    try {
      bytes = new Uint8Array(await sharp(Buffer.from(bytes), { limitInputPixels: 36_000_000 }).rotate().jpeg({ quality: 88 }).toBuffer());
      mime = "image/jpeg";
      ext = "jpg";
    } catch {
      return err("That picture could not be prepared for WhatsApp.");
    }
  }
  const safe = forward.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "poster";
  const r = await sendPosterMessage(user.id, { conversationId: String(input.conversationId ?? ""), caption: String(input.caption ?? ""), clientKey: input.clientKey, posterId: null, image: bytes, mime, filename: `${safe}.${ext}` });
  if (!r.ok) return err(r.error);
  await audit(user.id, "studio.inbox.sent", input.conversationId, { kind: "forward", forwardId: forward.id, messageId: r.data.messageId });
  return ok({ messageId: r.data.messageId });
}

export async function openConversation(conversationId: string): Promise<Result<null>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  await markRead(String(conversationId ?? ""));
  return ok(null);
}

export async function refreshFromKapso(): Promise<Result<{ conversations: number; threads: number; messages: number }>> {
  const user = await guard();
  if (!user) return err("You do not have the WhatsApp Inbox.", "not_permitted");
  const r = await syncFromKapso();
  if (!r.ok) return err(r.error);
  await audit(user.id, "studio.inbox.synced", "company-number", r.data);
  return ok(r.data);
}
