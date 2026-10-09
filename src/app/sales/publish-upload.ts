import { PUBLISH_MAX_BYTES, tooLargeMessage } from "@/lib/publish-limits";
import { err, ok, type Result } from "@/lib/result";

export type Uploaded = {
  id: string;
  filename: string;
  sizeBytes: number;
  /** The size as chosen, where it had to be compressed to fit. */
  compressedFrom?: number;
};

export type UploadStage = "compressing" | "sending";

/**
 * Send one chosen file to `/api/sales/publish-file` and hand back its id.
 *
 * A fetch to a route handler, not a server action — see the route for why: a
 * server action refuses anything over a megabyte before our code runs, which is
 * every real price list. Every failure, the network's included, comes back as
 * a Result with a sentence, never as a rejection a screen forgets to catch.
 *
 * **Too big is answered HERE, before a byte is sent.** A file over
 * `PUBLISH_MAX_BYTES` cannot be sent at all — the proxy keeps the first thirty
 * megabytes and drops the rest — so the compression has to happen in the
 * browser or not at all. A PDF or a JPEG over the limit has its photographs
 * scaled to print resolution (`lib/pdf-shrink.ts`, which says exactly what is
 * and is not touched); if it fits afterwards it goes, and the screen says it
 * was compressed and from what. If it still does not fit, the refusal names the
 * limit and says compressing was already tried. A file under the limit is
 * sent exactly as chosen — nobody asked for it to be altered.
 */
export async function uploadPublishFile(
  chosen: File,
  onStage?: (stage: UploadStage) => void,
): Promise<Result<Uploaded>> {
  let file = chosen;
  if (chosen.size > PUBLISH_MAX_BYTES) {
    const kind = shrinkable(chosen);
    if (!kind) return err(tooLargeMessage(chosen.name, chosen.size, false), "validation");
    onStage?.("compressing");
    const smaller = await compress(chosen, kind);
    if (smaller.size > PUBLISH_MAX_BYTES) {
      return err(tooLargeMessage(chosen.name, smaller.size, true), "validation");
    }
    file = smaller;
  }

  onStage?.("sending");
  const form = new FormData();
  form.set("file", file);
  try {
    const res = await fetch("/api/sales/publish-file", { method: "POST", body: form });
    const body = (await res.json().catch(() => null)) as
      | { ok: true; data: { id: string; filename: string; sizeBytes: number } }
      | { ok: false; error: string }
      | null;
    if (body?.ok) {
      return ok(file === chosen ? body.data : { ...body.data, compressedFrom: chosen.size });
    }
    if (body && !body.ok) return err(body.error, res.status === 403 ? "not_permitted" : "validation");
    return err(
      res.status === 413
        ? tooLargeMessage(chosen.name, file.size, file !== chosen)
        : `${chosen.name} could not be stored (the server answered ${res.status}). Try again.`,
      "validation",
    );
  } catch {
    return err(`${chosen.name} did not reach the server — check the connection and choose it again.`, "validation");
  }
}

function shrinkable(file: File): "pdf" | "jpeg" | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type === "image/jpeg" || /\.jpe?g$/.test(name)) return "jpeg";
  return null;
}

/** Never throws; where nothing could be done the original comes back. */
async function compress(file: File, kind: "pdf" | "jpeg"): Promise<File> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // pdf-lib is a few hundred kilobytes, and nearly every upload is under the
    // limit and never needs it — so it is fetched only on the day one is not.
    const { shrinkPdf, MAX_EDGE, QUALITY } = await import("@/lib/pdf-shrink");
    if (kind === "pdf") {
      const { bytes: out } = await shrinkPdf(bytes, canvasReencoder("none"));
      return out === bytes ? file : new File([out as BlobPart], file.name, { type: "application/pdf" });
    }
    // A photograph on its own carries its orientation in EXIF, which a PDF
    // viewer ignores and an image viewer obeys — so here it is applied, and
    // the re-encoded file needs none.
    const out = await canvasReencoder("from-image")(bytes, MAX_EDGE, QUALITY);
    return out && out.data.length < bytes.length
      ? new File([out.data as BlobPart], file.name, { type: "image/jpeg" })
      : file;
  } catch {
    return file;
  }
}

/** The browser's half of `JpegReencoder`: decode, scale, and write a JPEG. */
function canvasReencoder(orientation: ImageOrientation) {
  return async (jpeg: Uint8Array, maxEdge: number, quality: number) => {
    const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }), {
      imageOrientation: orientation,
    });
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) return null;
      return { data: new Uint8Array(await blob.arrayBuffer()), width, height };
    } finally {
      bitmap.close();
    }
  };
}
