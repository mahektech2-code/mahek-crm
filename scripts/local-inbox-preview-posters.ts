/**
 * LOCAL ONLY — makes a few real posters (and one uploaded picture) in YOUR LOCAL
 * development database, so the WhatsApp Inbox's poster picker has something to
 * pick while the Inbox is in its local sample-data preview.
 *
 *   DATABASE_URL=postgres://…@localhost:5432/mahekone_xxx NODE_ENV=test \
 *     npx tsx --conditions=react-server scripts/local-inbox-preview-posters.ts
 *
 * It refuses any database that is not on this machine and named mahekone…, and it
 * only ever adds rows through the Studio's own actions. It deletes nothing.
 */
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { previewAllowed } from "@/lib/studio/domain/inbox-preview-gate";

async function main() {
  if (!previewAllowed({ NODE_ENV: "development", STUDIO_INBOX_PREVIEW: "1", DATABASE_URL: process.env.DATABASE_URL })) {
    throw new Error("Refusing: DATABASE_URL is not a local mahekone… database.");
  }
  if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test, as in the usage line above.");
  const { db } = await import("@/db");
  const { users } = await import("@/db/schema");
  const { setTestUser } = await import("@/lib/auth");
  const { makePoster } = await import("@/lib/actions/studio");
  const { POST: upload } = await import("@/app/api/studio/forwards/upload/route");
  const [me] = await db.select().from(users).where(sql`${users.email} = ${"vikram@mahek.in"}`).limit(1);
  if (!me) throw new Error("The seeded local user vikram@mahek.in was not found. Run `npm run db:seed` on the local database first.");
  setTestUser(me);
  const customers = (await db.execute(sql`select id, name from customers where kind = 'customer' order by name limit 4`)) as unknown as { id: string; name: string }[];
  for (const c of customers) {
    const r = await makePoster({ customerId: c.id, templateId: "diwali-classic", language: "en", showProduct: true });
    console.log(r.ok ? `poster for ${c.name}: ${r.data.id}` : `poster for ${c.name} failed: ${r.error}`);
  }
  const png = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#7c3aed" } }).png().toBuffer();
  const form = new FormData();
  form.set("title", "Sample uploaded poster (local)");
  form.set("file", new File([new Uint8Array(png)], "sample.png", { type: "image/png" }));
  const res = await upload(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }));
  console.log("uploaded picture:", ((await res.json()) as { ok: boolean }).ok ? "ok" : "failed");
  setTestUser(null);
  await db.$client.end();
}
void main();
