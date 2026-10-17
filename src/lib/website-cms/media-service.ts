import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { websiteContent, websiteMedia, websitePublishLog, type User } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { fileStorage } from "@/lib/storage";
import { checkWebsiteImage, mediaIdsIn, mediaPublicPath, safeMediaFilename } from "./media-types";

/* ---------------------------------------------------------------------------
 * THE MEDIA LIBRARY.
 *
 * Two kinds of entry:
 *   upload — bytes this CMS stored (in the CRM's file store: Postgres, or S3 when
 *            configured), served on the public site at /cms-media/<id>/<name>;
 *   site   — a file that already ships inside the website's own image, listed so
 *            it can be picked. The CMS never writes or deletes these.
 *
 * Deleting is restricted and reversible: a file in use by ANY content, live or
 * working copy, cannot be deleted; a file not in use is soft-deleted (its bytes
 * stay in the store), so a mistaken delete is a database update to undo.
 * ------------------------------------------------------------------------- */

export type MediaView = {
  id: string;
  source: "upload" | "site";
  filename: string;
  contentType: string;
  sizeBytes: number;
  alt: string;
  /** Where it is used on the public site: the path an editor stores in a field. */
  url: string;
  createdAt: string;
  usedBy: string[];
};

const urlOf = (m: { id: string; source: string; filename: string; sitePath: string | null }) =>
  m.source === "site" ? (m.sitePath as string) : mediaPublicPath(m.id, m.filename);

/** Every piece of content that points at a file, by the file's URL. */
async function usageIndex(): Promise<{ byId: Map<string, string[]>; texts: { label: string; json: string }[] }> {
  const rows = await db.select().from(websiteContent);
  const byId = new Map<string, string[]>();
  const texts: { label: string; json: string }[] = [];
  for (const r of rows) {
    const label = `${r.kind}: ${(r.data as { name?: string; label?: string; title?: string; path?: string }).name ?? (r.data as { label?: string }).label ?? (r.data as { title?: string }).title ?? r.slug}`;
    const json = JSON.stringify([r.data, r.publishedData]);
    texts.push({ label, json });
    for (const id of mediaIdsIn(json)) byId.set(id, [...(byId.get(id) ?? []), label]);
  }
  return { byId, texts };
}

export async function listMedia(): Promise<MediaView[]> {
  const rows = await db
    .select()
    .from(websiteMedia)
    .where(isNull(websiteMedia.deletedAt))
    .orderBy(desc(websiteMedia.createdAt));
  const usage = await usageIndex();
  return rows.map((m) => {
    const url = urlOf(m);
    const usedBy =
      m.source === "upload"
        ? [...new Set(usage.byId.get(m.id) ?? [])]
        : [...new Set(usage.texts.filter((t) => t.json.includes(JSON.stringify(url).slice(1, -1))).map((t) => t.label))];
    return {
      id: m.id,
      source: m.source as "upload" | "site",
      filename: m.filename,
      contentType: m.contentType,
      sizeBytes: m.sizeBytes,
      alt: m.alt,
      url,
      createdAt: m.createdAt.toISOString(),
      usedBy,
    };
  });
}

export async function uploadMedia(
  user: User,
  input: { filename: string; bytes: Uint8Array; alt?: string },
): Promise<Result<MediaView>> {
  const checked = checkWebsiteImage(input.filename || "image", input.bytes);
  if (!checked.ok) return err(checked.error, "validation", [{ field: "file", message: checked.error }]);

  const hash = createHash("sha256").update(input.bytes).digest("hex");
  // The same picture uploaded twice is one library entry.
  const [same] = await db
    .select()
    .from(websiteMedia)
    .where(and(eq(websiteMedia.contentHash, hash), eq(websiteMedia.source, "upload"), isNull(websiteMedia.deletedAt)))
    .limit(1);
  if (same) {
    return ok(
      {
        id: same.id,
        source: "upload",
        filename: same.filename,
        contentType: same.contentType,
        sizeBytes: same.sizeBytes,
        alt: same.alt,
        url: urlOf(same),
        createdAt: same.createdAt.toISOString(),
        usedBy: [],
      },
      "That image is already in the library — using the existing copy.",
    );
  }

  const id = `wm_${randomUUID().slice(0, 16)}`;
  const filename = safeMediaFilename(input.filename || "image", checked.type);
  let storedRef: string;
  try {
    const stored = await fileStorage.upload({ key: `website-media/${id}`, body: input.bytes, contentType: checked.type });
    storedRef = stored.ref;
  } catch {
    return err("The image could not be stored. Nothing was added — try again.", "validation");
  }
  const [row] = await db
    .insert(websiteMedia)
    .values({
      id,
      source: "upload",
      filename,
      contentType: checked.type,
      sizeBytes: input.bytes.byteLength,
      contentHash: hash,
      storedRef,
      alt: (input.alt ?? "").trim().slice(0, 200),
      uploadedById: user.id,
    })
    .returning();
  await db.insert(websitePublishLog).values({
    id: `wl_${randomUUID().slice(0, 12)}`,
    actorId: user.id,
    action: "media-upload",
    slug: filename,
    contentId: id,
    detail: `${checked.type}, ${input.bytes.byteLength} bytes`,
  });
  return ok(
    {
      id: row.id,
      source: "upload",
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      alt: row.alt,
      url: urlOf(row),
      createdAt: row.createdAt.toISOString(),
      usedBy: [],
    },
    "Image added to the library. It appears on the live site only once content that uses it is published.",
  );
}

export async function updateMediaAlt(id: string, alt: string): Promise<Result> {
  const [row] = await db
    .update(websiteMedia)
    .set({ alt: alt.trim().slice(0, 200) })
    .where(and(eq(websiteMedia.id, id), isNull(websiteMedia.deletedAt)))
    .returning({ id: websiteMedia.id });
  return row ? { ok: true, data: undefined, message: "Description saved." } : err("That image no longer exists.", "not_found");
}

export async function deleteMedia(user: User, id: string): Promise<Result> {
  const [row] = await db.select().from(websiteMedia).where(eq(websiteMedia.id, id)).limit(1);
  if (!row || row.deletedAt) return err("That image no longer exists.", "not_found");
  if (row.source !== "upload") {
    return err("This file is part of the website itself. It can be used here but not deleted from MahekOne.", "rule_violation");
  }
  const { byId } = await usageIndex();
  const users = [...new Set(byId.get(id) ?? [])];
  if (users.length) {
    return err(
      `This image is in use by ${users.slice(0, 3).join(", ")}${users.length > 3 ? ` and ${users.length - 3} more` : ""}. Remove it from that content first.`,
      "rule_violation",
    );
  }
  await db.update(websiteMedia).set({ deletedAt: new Date(), deletedById: user.id }).where(eq(websiteMedia.id, id));
  await db.insert(websitePublishLog).values({
    id: `wl_${randomUUID().slice(0, 12)}`,
    actorId: user.id,
    action: "media-delete",
    slug: row.filename,
    contentId: id,
  });
  return { ok: true, data: undefined, message: "Image removed from the library." };
}

/** Bytes for the public route. Null when unknown, deleted or not an upload. */
export async function readMedia(id: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string; hash: string | null } | null> {
  const [row] = await db
    .select()
    .from(websiteMedia)
    .where(and(eq(websiteMedia.id, id), eq(websiteMedia.source, "upload"), isNull(websiteMedia.deletedAt)))
    .limit(1);
  if (!row?.storedRef) return null;
  try {
    const buf = await fileStorage.read(row.storedRef);
    return { bytes: new Uint8Array(buf), contentType: row.contentType, filename: row.filename, hash: row.contentHash };
  } catch {
    return null;
  }
}
