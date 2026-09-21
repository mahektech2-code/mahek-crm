import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { createDocumentsFromUploads } from "@/lib/services/price-list-parse-service";

/**
 * WHERE A PRICE LIST COMES IN.
 *
 * A route handler rather than a server action, for the reason dictation is
 * one: a server action's body is capped at a megabyte and a folder of scanned
 * price lists is not. It answers with one row per file — the document it
 * became, the document it duplicates, or why it was refused — because an
 * import of thirty must not be all-or-nothing.
 *
 * Reading the file is a SEPARATE call. Uploading thirty and parsing them in
 * one request would hold a connection open for minutes and give the screen
 * nothing to show; the import screen parses them one at a time and watches
 * each through the status endpoint.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { allowed } = await checkCapability("pricelist.manage");
  if (!allowed) {
    return NextResponse.json({ error: "Importing a price list is not something you can do." }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "That upload could not be read." }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "No files were sent." }, { status: 400 });

  const documents = await createDocumentsFromUploads(
    await Promise.all(
      files.map(async (f) => ({
        filename: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
        declaredType: f.type || undefined,
      })),
    ),
    user.id,
  );

  return NextResponse.json({ documents });
}
