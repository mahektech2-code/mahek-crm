import type { AttachmentView } from "@/lib/services/attachment-service";

/* ---------------------------------------------------------------------------
 * The files hanging off a record, shown as something a person can open.
 *
 * Attachments were write-only in MahekOne for as long as they had existed —
 * uploaded, stored, and displayed by nothing. A screenshot nobody can open is
 * a screenshot nobody sent, and the bug it shows gets described in words
 * instead, badly.
 *
 * Bytes come from `/api/attachments/[id]`, never a stored URL: that route
 * checks who may see the parent record, so a link copied out of here opens for
 * the people who could already see it and 404s for everybody else.
 * ------------------------------------------------------------------------- */

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentStrip({
  files,
  label,
}: {
  files: AttachmentView[];
  /** Names what these are, where the surrounding screen does not. */
  label?: string;
}) {
  if (!files.length) return null;

  return (
    <div className="mt-3">
      {label ? (
        <span className="mb-1.5 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          {label}
        </span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {files.map((f) => (
          <a
            key={f.id}
            href={`/api/attachments/${f.id}`}
            target="_blank"
            rel="noreferrer"
            title={`${f.filename} · ${size(f.sizeBytes)}${f.uploadedByName ? ` · ${f.uploadedByName}` : ""}`}
            className="block rounded-[4px] border border-line bg-surface hover:border-brand"
          >
            {f.isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/attachments/${f.id}`}
                alt={f.filename}
                className="h-20 w-20 rounded-[3px] object-cover"
              />
            ) : (
              <span className="flex h-20 w-20 flex-col items-center justify-center gap-1 px-1 text-center">
                <span className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
                  {f.contentType.includes("pdf") ? "PDF" : "File"}
                </span>
                <span className="line-clamp-2 text-[11px] leading-[13px] text-muted">
                  {f.filename}
                </span>
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
