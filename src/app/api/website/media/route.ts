import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditAny } from "@/lib/website-cms/access";
import { WEBSITE_IMAGE_MAX_BYTES } from "@/lib/website-cms/media-types";
import { uploadMedia } from "@/lib/website-cms/media-service";

/**
 * Upload one image for the website. A route and not a server action because a
 * photograph is past what a server action's body limit allows — the same reason
 * the ERP and price-list uploads are routes.
 *
 * The session cookie is `SameSite=Lax`, so another site cannot post here as the
 * signed-in person. Who may upload is the server's own check — any Website
 * content module — and the file is judged by its BYTES (media-types.ts), never
 * its name or what the browser called it.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again to upload." }, { status: 401 });
  if (!(await canEditAny(user.id))) {
    return NextResponse.json({ ok: false, error: "You do not have access to the website's images." }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "That upload could not be read." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file was sent." }, { status: 400 });
  // Refuse a huge body before reading it all into memory.
  if (file.size > WEBSITE_IMAGE_MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return NextResponse.json(
      { ok: false, error: `${file.name} is ${mb} MB. The limit is ${WEBSITE_IMAGE_MAX_BYTES / (1024 * 1024)} MB.` },
      { status: 413 },
    );
  }

  const result = await uploadMedia(user, {
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    alt: typeof form.get("alt") === "string" ? (form.get("alt") as string) : "",
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, media: result.data, message: result.message });
}
