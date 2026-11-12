import { NextResponse } from "next/server";
import { resolveScope } from "@/lib/access-control";
import { languageSchema } from "@/lib/studio/domain/language";
import { studioCaller, imageResponse } from "@/lib/studio/http";
import { getRecipient } from "@/lib/studio/recipients";
import { renderRecipe } from "@/lib/studio/render-service";

/* The poster as it would be made, before anything is stored — so somebody
   sees a long name wrap, or their own message fit, before pressing Make.
   The same checks as making it: the recipient must be in the asker's book,
   and what they typed is held to the same rules. JPEG, because it is looked
   at once and thrown away. */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const caller = await studioCaller("studio.make");
  if ("response" in caller) return caller.response;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "That request is not valid." }, { status: 400 });
  }
  const lang = languageSchema.safeParse(body.language);
  if (!lang.success || typeof body.customerId !== "string" || typeof body.templateId !== "string") return NextResponse.json({ ok: false, error: "That request is not valid." }, { status: 400 });
  const { scope } = await resolveScope();
  const r = await getRecipient(scope.userIds, body.customerId);
  if (!r) return NextResponse.json({ ok: false, error: "That lead or customer is not in your book." }, { status: 404 });
  let product = r.recipient.product;
  if (body.productId === "") product = null;
  else if (typeof body.productId === "string") product = r.products.find((p) => p.id === body.productId) ?? null;
  const drawn = await renderRecipe(
    {
      audience: r.audience,
      recipient: { ...r.recipient, product },
      senderName: caller.user.name,
      templateId: body.templateId,
      language: lang.data,
      variantId: typeof body.variantId === "string" && body.variantId ? body.variantId : null,
      showProduct: body.showProduct !== false,
      personal: (body.personal && typeof body.personal === "object" ? body.personal : {}) as Record<string, string>,
    },
    "jpeg",
  );
  if (!drawn.ok) return NextResponse.json({ ok: false, error: drawn.error, field: drawn.field ?? null }, { status: 422 });
  return imageResponse(drawn.data.image, "image/jpeg");
}
