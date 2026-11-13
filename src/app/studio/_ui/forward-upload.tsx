"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Input } from "@/components/ui/primitives";

/* Uploading a finished poster. A route rather than a server action: a poster is
   routinely more than an action's one-megabyte body. */
export function ForwardUpload() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose a JPG, PNG or WebP image to upload.");
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("title", title);
    form.set("file", file);
    try {
      const res = await fetch("/api/studio/forwards/upload", { method: "POST", body: form });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: { id: string } };
      if (!res.ok || !j.ok || !j.data) return setError(j.error ?? "The upload did not finish. Try again.");
      router.push(`/studio/forward/${j.data.id}`);
    } catch {
      setError("The server could not be reached. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Name for this poster" className="w-[260px]">
          <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Navratri greeting" />
        </Field>
        <Field label="Finished poster" hint="JPG, JPEG, PNG or WebP, up to 10 MB. It is forwarded exactly as it is — nothing is added or changed." className="w-[320px]">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
        </Field>
        <Button variant="primary" type="submit" disabled={busy || !title.trim() || !file}>
          {busy ? "Uploading…" : "Upload poster"}
        </Button>
      </form>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </Card>
  );
}
