import { hireContext } from "@/lib/hire/access";
import { hireTrail } from "@/lib/hire/services/core";
import { audioFor } from "@/lib/hire/services/voice";
import { fileStorage } from "@/lib/storage";

/**
 * A voice-screen recording, for somebody who may see the application. A file
 * they may not hear and a file that does not exist answer the same 404. Range
 * requests are honoured so the player can seek to a question.
 */
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const ctx = await hireContext();
  if (!ctx) return new Response("Not found", { status: 404 });
  const { fileId } = await params;
  const f = await audioFor(ctx, fileId);
  if (!f) return new Response("Not found", { status: 404 });
  const bytes = new Uint8Array(await fileStorage.read(f.ref));
  const range = req.headers.get("range");
  if (!range) {
    await hireTrail(ctx, { applicationId: f.applicationId, candidateId: f.candidateId, entityType: "file", entityId: fileId, event: "recording_played", summary: "Listened to the AI voice screen recording" });
    return new Response(bytes, { headers: { "Content-Type": f.contentType, "Content-Length": String(bytes.length), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" } });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
  if (start >= bytes.length) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.length}` } });
  const part = bytes.slice(start, end + 1);
  return new Response(part, {
    status: 206,
    headers: { "Content-Type": f.contentType, "Content-Length": String(part.length), "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" },
  });
}
