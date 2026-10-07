import { err, ok, type Result } from "@/lib/result";

/**
 * Send one chosen file to `/api/sales/publish-file` and hand back its id.
 *
 * A fetch to a route handler, not a server action — see the route for why: a
 * server action refuses anything over a megabyte before our code runs, which is
 * every real price list. Every failure, the network's included, comes back as
 * a Result with a sentence, never as a rejection a screen forgets to catch.
 */
export async function uploadPublishFile(
  file: File,
): Promise<Result<{ id: string; filename: string; sizeBytes: number }>> {
  const form = new FormData();
  form.set("file", file);
  try {
    const res = await fetch("/api/sales/publish-file", { method: "POST", body: form });
    const body = (await res.json().catch(() => null)) as
      | { ok: true; data: { id: string; filename: string; sizeBytes: number } }
      | { ok: false; error: string }
      | null;
    if (body?.ok) return ok(body.data);
    if (body && !body.ok) return err(body.error, res.status === 403 ? "not_permitted" : "validation");
    return err(
      res.status === 413
        ? `${file.name} is too large to send.`
        : `${file.name} could not be stored (the server answered ${res.status}). Try again.`,
      "validation",
    );
  } catch {
    return err(`${file.name} did not reach the server — check the connection and choose it again.`, "validation");
  }
}
