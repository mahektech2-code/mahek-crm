"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Input } from "@/components/ui/primitives";

/* Uploading artwork for a new design. It goes to a route rather than a server
   action because artwork is routinely more than an action's one-megabyte
   body, and a capped action fails without a word. */
export function UploadForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose an image to upload.");
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("name", name);
    form.set("file", file);
    try {
      const res = await fetch("/api/studio/designs/upload", { method: "POST", body: form });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: { id: string } };
      if (!res.ok || !j.ok || !j.data) return setError(j.error ?? "The upload did not finish. Try again.");
      router.push(`/studio/designs/${j.data.id}`);
    } catch {
      setError("The server could not be reached. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Design name" className="w-[260px]">
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Monsoon offer" />
        </Field>
        <Field label="Artwork" hint="PNG, JPG or WebP, at least 540 pixels wide, with no text where names will go." className="w-[300px]">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
        </Field>
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || !file}>
          {busy ? "Uploading…" : "Upload and place fields"}
        </Button>
      </form>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </Card>
  );
}
