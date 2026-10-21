import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { uploadPdf } from "@/lib/services/bank-statement-service";

/** A statement PDF, while it is kept (`bankStatements.pdfRetentionDays`). After that it is gone and says so. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const allowed =
    (await canOpenModule(user.id, "accounts.bank-statements")) ||
    (await canOpenModule(user.id, "accounts.bank-reconcile")) ||
    (await canOpenModule(user.id, "accounts.bank-uploads"));
  if (!allowed) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { id } = await params;
  const pdf = await uploadPdf(id);
  if (!pdf) return NextResponse.json({ error: "This statement's PDF has been deleted. The lines read from it are kept." }, { status: 410 });
  return new NextResponse(Buffer.from(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${pdf.name.replace(/["\\]/g, "")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
