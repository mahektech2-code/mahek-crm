import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireDocuments, hireFiles } from "@/db/schema";
import { fileStorage } from "@/lib/storage";
import { hireContext } from "@/lib/hire/access";
import { audit, getApplication } from "@/lib/hire/services/core";

/**
 * A file Hire holds, read through Hire's own rules.
 *
 * Scope first — the application must be one this person can see — then the
 * capability: an identity or bank document IS the number on it, so opening
 * one needs `unmask` exactly as revealing the vaulted number does; any other
 * document needs `documents`. Not allowed and not found answer the SAME 404,
 * or this endpoint becomes a way to learn which candidates exist. Every read
 * is an audit line.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const notFound = () => new Response("Not found", { status: 404 });
  const ctx = await hireContext();
  if (!ctx) return notFound();
  const { id } = await params;
  const [f] = await db.select().from(hireFiles).where(and(eq(hireFiles.id, id), isNull(hireFiles.removedAt))).limit(1);
  if (!f || !f.applicationId) return notFound();
  const b = await getApplication(ctx, f.applicationId);
  if (!b) return notFound();

  const [doc] = await db.select({ key: hireDocuments.requirementKey }).from(hireDocuments).where(eq(hireDocuments.fileId, f.id)).limit(1);
  const req = doc ? b.def.documents.find((r) => r.key === doc.key) : null;
  const restricted = f.purpose === "document" && (req?.pii === "restricted" || req?.kind === "aadhaar" || req?.kind === "pan" || req?.kind === "bank");
  const allowed = restricted ? ctx.can("unmask") : ctx.can("documents") || ctx.can("unmask") || (f.purpose !== "document" && ctx.can("interview"));
  if (!allowed) return notFound();

  let bytes: ArrayBuffer;
  try {
    bytes = await fileStorage.read(f.storedRef);
  } catch {
    return new Response("The file could not be read from storage.", { status: 502 });
  }
  await audit(ctx, {
    applicationId: f.applicationId,
    candidateId: f.candidateId,
    entityType: "file",
    entityId: f.id,
    eventType: "file_viewed",
    summary: `Opened ${req?.label ?? f.purpose} (${f.filename})`,
    pii: req && req.pii !== "none" ? [req.kind] : undefined,
  });
  return new Response(bytes, {
    headers: {
      "Content-Type": f.contentType,
      "Content-Disposition": `inline; filename="${f.filename.replace(/[^\w.\- ]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
