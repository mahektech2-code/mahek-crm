"use client";

import * as React from "react";
import { Field } from "@/components/ui/primitives";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/file-types";

/* ---------------------------------------------------------------------------
 * Picking the photographs that go on a complaint.
 *
 * One component for the complaints dialog and the call drawer, because they
 * ask the same question and used to answer it twice — two pickers, two type
 * lists, and only one of them counting anything.
 *
 * Three things it does that a bare file input does not:
 *
 *   IT ADDS RATHER THAN REPLACES. A telecaller photographing damaged goods
 *   takes them one at a time from the camera roll, and the second visit to the
 *   picker used to throw the first away without saying so.
 *
 *   IT STOPS AT THE LIMIT, ON THE SCREEN. The server binds what fits and
 *   silently drops the rest, so a seventh picture used to vanish between
 *   pressing Save and reading the message. Refusing it here, by name, is the
 *   only place the person can still do something about it.
 *
 *   IT LETS ONE GO. A wrong photograph could only be fixed by starting the
 *   whole selection again.
 *
 * The accept list is `ACCEPTED_IMAGE_TYPES` and nothing else. It must never
 * offer more than the server takes — WebP was offered here once while
 * `sniffContentType` knew nothing about it, so a telecaller could pick a file
 * the picker accepted and the save quietly refused.
 * ------------------------------------------------------------------------- */

/** Same file twice is one file — name and size are enough to know. */
const key = (f: File) => `${f.name}:${f.size}`;

const EXTENSIONS = "JPG, JPEG or PNG";

export function ImagePicker({
  files,
  onChange,
  max,
  label = "Upload picture",
}: {
  files: File[];
  onChange: (files: File[]) => void;
  /** From configuration — `attachments.maxPerComplaint`, never a constant. */
  max: number;
  label?: string;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const previews = React.useMemo(
    () => files.map((f) => ({ key: key(f), url: URL.createObjectURL(f), name: f.name })),
    [files],
  );
  React.useEffect(() => {
    return () => previews.forEach((p) => URL.revokeObjectURL(p.url));
  }, [previews]);

  const room = Math.max(0, max - files.length);

  function add(picked: File[]) {
    const wrongType = picked.filter((f) => !ACCEPTED_IMAGE_TYPES.includes(f.type));
    const seen = new Set(files.map(key));
    const fresh = picked.filter(
      (f) => ACCEPTED_IMAGE_TYPES.includes(f.type) && !seen.has(key(f)),
    );

    const taken = fresh.slice(0, room);
    const overflow = fresh.length - taken.length;

    // Both refusals can happen at once, and saying only the first would leave
    // somebody wondering where the other file went.
    const notes: string[] = [];
    if (wrongType.length) {
      notes.push(
        wrongType.length === 1
          ? `${wrongType[0].name} is not a ${EXTENSIONS} image.`
          : `${wrongType.length} files were not ${EXTENSIONS} images.`,
      );
    }
    if (overflow) {
      notes.push(
        `${max} pictures is the limit, so ${overflow} more ${overflow === 1 ? "was" : "were"} left off.`,
      );
    }
    setError(notes.join(" ") || null);

    if (taken.length) onChange([...files, ...taken]);
  }

  return (
    <Field
      label={label}
      hint={`${EXTENSIONS} - photos of the damaged or short goods, if any. Up to ${max}.`}
      error={error}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        multiple
        disabled={room === 0}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          // Cleared so picking the same file again after removing it still
          // fires a change event.
          e.target.value = "";
        }}
        className="block w-full text-sm text-body file:mr-3 file:cursor-pointer file:rounded-[4px] file:border file:border-line file:bg-surface file:px-2.5 file:py-1.5 file:text-sm file:text-ink disabled:cursor-not-allowed disabled:opacity-60"
      />

      {files.length ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            {previews.map((p, i) => (
              <div key={p.key} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.name}
                  title={p.name}
                  className="h-14 w-14 rounded-[4px] border border-line object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name}`}
                  onClick={() => {
                    onChange(files.filter((_, n) => n !== i));
                    setError(null);
                  }}
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-[13px] leading-none text-muted hover:text-ink"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {files.length} of {max} picture{files.length === 1 ? "" : "s"}
            {room === 0 ? " - that is the limit" : ""}
          </p>
        </>
      ) : null}
    </Field>
  );
}
