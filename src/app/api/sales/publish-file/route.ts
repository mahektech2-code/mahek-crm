import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { isPlatformAdmin, levelInApp } from "@/lib/access-control";
import { salesGateRefusal } from "@/lib/sales-gate";
import { createAttachment } from "@/lib/services/attachment-service";
import { PUBLISH_MAX_BYTES, PUBLISH_MAX_MB, megabytes, officeFileRefusal } from "@/lib/publish-limits";

/* ---------------------------------------------------------------------------
 * ONE FILE FOR THE LIBRARY OR THE TRAINING, stored unparented.
 *
 * THIS WAS A SERVER ACTION, AND NOTHING BIGGER THAN A MEGABYTE EVER ARRIVED.
 * Next caps a server action's body at 1 MB before a line of ours runs, and a
 * price list or a product catalogue as a PDF is routinely three. The action
 * rejected rather than returning a Result, the screen awaited it inside a
 * `try`/`finally` with no `catch`, and so the spinner stopped and nothing else
 * happened: no file, no error, a Publish button that stayed grey. Managers
 * reported it as "documents will not publish", which is exactly what it was.
 *
 * A route handler is not under that cap — the same reason dictation is one.
 *
 * AND THEN NOTHING BIGGER THAN TEN MEGABYTES ARRIVED WHOLE. Every request
 * passes through `src/proxy.ts`, and Next buffers a proxied body only up to
 * `proxyClientMaxBodySize` — ten megabytes by default — handing the route the
 * first N bytes with nothing but a warning in the server log. The form then
 * failed to parse and the screen said "the file did not arrive whole, try
 * choosing it again", which was false and sent somebody round the same loop
 * three times. The ceiling is `PUBLISH_MAX_MB` now, the proxy buffer is set
 * above it, and a body declaring more than that is refused BEFORE it is read,
 * in the same words the screen uses. The screen compresses first, so reaching
 * this refusal means a client that did not.
 * The HRMS and ERP uploads are route handlers for the same reason.
 *
 * The gate is `requireSalesAccess`'s, asked through the same pure
 * `salesGateRefusal`: a manager of the Sales Dashboard holding Documents or
 * Training. The bind happens when the form saves (§4), which is why an
 * abandoned form only leaves an orphan for the nightly sweep.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const MODULES = ["sales.documents", "sales.knowledge"];

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in again — your session has ended." }, { status: 401 });
  }
  const [level, platformAdmin, held] = await Promise.all([
    levelInApp(user, "sales"),
    isPlatformAdmin(user),
    Promise.all(MODULES.map((k) => canOpenModule(user.id, k))),
  ]);
  const refusal = salesGateRefusal({
    level,
    platformAdmin,
    needManager: true,
    modulesAsked: MODULES,
    modulesHeld: MODULES.filter((_, i) => held[i]),
  });
  if (refusal) return NextResponse.json({ ok: false, error: refusal }, { status: 403 });

  // The overhead allowance is the multipart framing around the file: the
  // boundary, the headers, the filename. A megabyte is several hundred times
  // what that is, and well inside the proxy's buffer.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > PUBLISH_MAX_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { ok: false, error: `This file is about ${megabytes(declared)}. The limit is ${PUBLISH_MAX_MB} MB.` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "The file did not arrive whole. Try choosing it again." },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "No file arrived." }, { status: 400 });
  }

  // Before the sniffer, which would call a .docx "not a JPG, PNG or PDF" and
  // stop there — true, and no help to whoever has to make the PDF.
  const office = officeFileRefusal(file.name);
  if (office) return NextResponse.json({ ok: false, error: office }, { status: 400 });

  const created = await createAttachment({
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    maxSizeMb: PUBLISH_MAX_MB,
  });
  if (!created.ok) {
    return NextResponse.json({ ok: false, error: created.error }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    data: { id: created.data.id, filename: file.name, sizeBytes: file.size },
  });
}
