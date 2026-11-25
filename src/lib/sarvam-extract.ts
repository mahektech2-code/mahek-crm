import "server-only";

/* ---------------------------------------------------------------------------
 * Sarvam Document Intelligence — Extract.
 *
 * A photograph or PDF and a list of the fields wanted go up; those fields come
 * back as JSON, each with a confidence. It is a JOB, not a call: create it
 * (which also starts it), poll its status, then fetch the result. Several
 * files in one job are read as ONE document and answered once — which is
 * exactly what a card's front, back and shop board are.
 *
 *   POST /doc-ai/v1/job/extract      multipart: file…, schema, mode, language
 *   GET  /doc-ai/v1/job/{id}/status  pending → running → completed | partially_completed | failed | rejected
 *   GET  /doc-ai/v1/job/{id}/results 409 until the job is finished
 *
 * WHAT SARVAM KEEPS: the documents, for its account's retention (eight days
 * as of November 2026, not settable per job). Every caller is behind a
 * setting that says so, because a lead scan otherwise keeps no photo at all.
 *
 * Pricing is not published; the rate limit on pay-as-you-go is 30 jobs a
 * minute, which a trial of twenty bills read one at a time never approaches.
 * ------------------------------------------------------------------------- */

const BASE = "https://api.sarvam.ai/doc-ai/v1/job";
const POLL_MS = 2_000;
const TERMINAL = new Set(["completed", "partially_completed", "failed", "rejected"]);

export type ExtractFile = { bytes: Uint8Array; mediaType: string; filename: string };

export type ExtractOutcome =
  | { ok: true; result: Record<string, unknown>; ms: number }
  | { ok: false; error: string; ms: number };

export async function sarvamExtract({
  key,
  files,
  schema,
  timeoutMs,
  mode = "basic",
}: {
  key: string;
  files: ExtractFile[];
  schema: Record<string, unknown>;
  timeoutMs: number;
  mode?: "basic" | "advanced";
}): Promise<ExtractOutcome> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const fail = (error: string): ExtractOutcome => ({ ok: false, error: error.slice(0, 300), ms: Date.now() - started });
  const headers = { "api-subscription-key": key };

  try {
    const form = new FormData();
    for (const f of files) form.append("file", new Blob([f.bytes as BlobPart], { type: f.mediaType }), f.filename);
    form.append("schema", JSON.stringify(schema));
    form.append("mode", mode);
    const created = await fetch(`${BASE}/extract`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(left()),
      cache: "no-store",
    });
    const job = (await created.json().catch(() => null)) as { job_id?: string; status?: string } | null;
    if (!created.ok || !job?.job_id) return fail(`Sarvam refused the job (${created.status}): ${describe(job)}`);

    let status = job.status ?? "pending";
    while (!TERMINAL.has(status)) {
      if (Date.now() + POLL_MS >= deadline) return fail(`Sarvam had not finished in ${Math.round(timeoutMs / 1000)} s.`);
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = await fetch(`${BASE}/${job.job_id}/status`, { headers, signal: AbortSignal.timeout(left()), cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      if (!res.ok) return fail(`Sarvam's status check answered ${res.status}: ${describe(body)}`);
      status = body?.status ?? status;
    }
    if (status === "failed" || status === "rejected") return fail(`Sarvam ${status} the job.`);

    const res = await fetch(`${BASE}/${job.job_id}/results?format=json`, {
      headers,
      signal: AbortSignal.timeout(left()),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
    if (!res.ok || !body || typeof body.result !== "object" || body.result === null) {
      return fail(`Sarvam's result could not be read (${res.status}).`);
    }
    return { ok: true, result: body.result as Record<string, unknown>, ms: Date.now() - started };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function describe(body: unknown): string {
  if (!body || typeof body !== "object") return "no detail";
  const b = body as { error?: { message?: string; code?: string } | string; message?: string; detail?: unknown };
  if (typeof b.error === "string") return b.error;
  return b.error?.message ?? b.error?.code ?? b.message ?? (b.detail ? JSON.stringify(b.detail) : "no detail");
}
