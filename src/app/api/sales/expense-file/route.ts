import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { isPlatformAdmin, levelInApp } from "@/lib/access-control";
import { salesGateRefusal } from "@/lib/sales-gate";
import { createAttachment } from "@/lib/services/attachment-service";
import {
  PUBLISH_MAX_BYTES,
  PUBLISH_MAX_MB,
  megabytes,
} from "@/lib/publish-limits";

/* ---------------------------------------------------------------------------
 * A BILL FOR AN EXPENSE THE OFFICE ENTERS ON A SALESMAN'S BEHALF, stored
 * unparented until `addExpenseFor` files it under the expense.
 *
 * A route handler and not a server action for the reason `publish-file` gives
 * at length: an action's body is capped at a megabyte before a line of ours
 * runs, and a scanned hotel bill is routinely more. The gate is the Expenses
 * screen's — a Sales Dashboard manager holding it. A form abandoned after the
 * upload leaves an orphan for the nightly sweep, the same as everywhere else.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const MODULES = ["sales.expenses"];

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Sign in again — your session has ended." },
      { status: 401 },
    );
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
  if (refusal)
    return NextResponse.json({ ok: false, error: refusal }, { status: 403 });

  // The overhead allowance is the multipart framing around the file: the
  // boundary, the headers, the filename. A megabyte is several hundred times
  // what that is, and well inside the proxy's buffer.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > PUBLISH_MAX_BYTES + 1024 * 1024) {
    return NextResponse.json(
      {
        ok: false,
        error: `This file is about ${megabytes(declared)}. The limit is ${PUBLISH_MAX_MB} MB.`,
      },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "The file did not arrive whole. Try choosing it again.",
      },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "No file arrived." },
      { status: 400 },
    );
  }

  const created = await createAttachment({
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    maxSizeMb: PUBLISH_MAX_MB,
  });
  if (!created.ok) {
    return NextResponse.json(
      { ok: false, error: created.error },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    data: { id: created.data.id, filename: file.name, sizeBytes: file.size },
  });
}
