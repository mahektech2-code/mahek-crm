import { revalidatePath } from "next/cache";
import { err, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "@/lib/hire/access";
import { acknowledgeAssetBySlip, fileEmploymentDoc, markEmploymentDocSigned } from "@/lib/hire/services/onboarding-records";

/**
 * Onboarding's file uploads — a signed employment document, its filed copy, a
 * signed asset slip — as a ROUTE HANDLER, not a server action. Next refuses a
 * server action's body past 1 MB before a line of ours runs, and a phone photo
 * of a signed contract is routinely three (docs/agents/field-library-and-sheet-costing.md
 * tells the same story for the library). The services hold the 10 MB ceiling
 * and sniff the bytes; each op checks its own capability.
 */
export async function POST(req: Request): Promise<Response> {
  const json = (r: Result<unknown>) => Response.json(r, { status: r.ok ? 200 : r.code === "not_permitted" ? 403 : 200 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(err("That upload could not be read.", "validation"));
  }
  const op = String(form.get("op") ?? "");
  const raw = form.get("file");
  const file = raw instanceof File && raw.size ? raw : null;
  try {
    let r: Result<unknown>;
    if (op === "doc-signed") {
      const ctx = await requireHireCap("employmentDocs");
      r = await markEmploymentDocSigned(ctx, String(form.get("docId") ?? ""), String(form.get("signedOn") ?? ""), file);
    } else if (op === "doc-filed") {
      const ctx = await requireHireCap("employmentDocs");
      r = await fileEmploymentDoc(ctx, String(form.get("docId") ?? ""), file);
    } else if (op === "asset-slip") {
      const ctx = await requireHireCap("assets");
      if (!file) return json(err("Choose a file.", "validation"));
      r = await acknowledgeAssetBySlip(ctx, String(form.get("applicationId") ?? ""), String(form.get("key") ?? ""), file);
    } else return json(err("Unknown upload.", "validation"));
    if (r.ok) revalidatePath("/hire", "layout");
    return json(r);
  } catch (e) {
    if (e instanceof HireNotPermitted) return json(err(e.message, "not_permitted"));
    console.error("hire upload:", e instanceof Error ? e.message : e);
    return json(err("That upload did not save. Try again."));
  }
}
