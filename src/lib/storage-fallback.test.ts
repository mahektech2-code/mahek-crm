import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/* ---------------------------------------------------------------------------
 * Turning the bucket on must not lose what came before it.
 *
 * Everything uploaded before an S3 bucket is configured lives in
 * `attachment_bytes`, and nothing migrates it. Without a fallback, the day
 * somebody sets the bucket variable every existing payment proof, bill
 * photograph and check-in selfie stops opening — and it fails as a 404 on a
 * screen, which reads as "the file was lost" rather than "the store moved".
 *
 * This is the test that would have caught it. It was very nearly shipped: the
 * comment in `storage.ts` claimed "a stored_ref names the store it was written
 * to", which the code did not do and could not do — there is no such column.
 *
 * It stands a stub bucket up that has nothing in it, points the module at it,
 * puts bytes in Postgres by hand, and asserts a read still finds them.
 * ------------------------------------------------------------------------- */

let server: Server;
let origin: string;
const bucket = new Map<string, Buffer>();

before(async () => {
  server = createServer((req, res) => {
    const key = decodeURIComponent(req.url!);
    if (req.method === "GET") {
      const found = bucket.get(key);
      if (!found) return void res.writeHead(404).end("no such key");
      return void res.writeHead(200).end(found);
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      return void req.on("end", () => {
        bucket.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
    }
    if (req.method === "DELETE") {
      const existed = bucket.delete(key);
      return void res.writeHead(existed ? 204 : 404).end();
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /* Point the module at the stub. Set BEFORE it is imported, because the
     backend is chosen once at module load — which is itself worth knowing:
     changing these at runtime does nothing. */
  process.env.S3_BUCKET = "test-attachments";
  process.env.S3_ENDPOINT = origin;
  process.env.S3_REGION = "auto";
  process.env.S3_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.S3_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { db } = await import("@/db");
  await db.$client.end();
});

describe("moving to a bucket does not orphan what came before", () => {
  test("the backend selected is the bucket", async () => {
    const { fileStorage } = await import("@/lib/storage");
    assert.equal(fileStorage.kind, "s3");
  });

  test("a file written before the switch is still readable", async () => {
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const { fileStorage } = await import("@/lib/storage");

    const ref = "attachments/from-before-the-switch";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);
    await db.execute(sql`
      insert into attachment_bytes (ref, bytes) values (${ref}, ${bytes})
      on conflict (ref) do update set bytes = excluded.bytes
    `);
    assert.equal(bucket.has(`/test-attachments/${ref}`), false, "not in the bucket");

    const back = Buffer.from(await fileStorage.read(ref));
    assert.ok(back.equals(bytes), "a pre-switch attachment must still open");
  });

  test("a file written after the switch comes from the bucket", async () => {
    const { fileStorage } = await import("@/lib/storage");
    const ref = "attachments/after-the-switch";
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const stored = await fileStorage.upload({ key: ref, body: bytes, contentType: "image/png" });
    assert.ok(bucket.has(`/test-attachments/${ref}`), "it went to the bucket");

    const back = Buffer.from(await fileStorage.read(stored.ref));
    assert.ok(back.equals(bytes));
  });

  test("something in neither place fails, and says it looked in both", async () => {
    const { fileStorage } = await import("@/lib/storage");
    await assert.rejects(
      () => fileStorage.read("attachments/never-existed"),
      /not in the database either/,
    );
  });

  test("removing takes it out of both, so retention cannot leave rows behind", async () => {
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const { fileStorage } = await import("@/lib/storage");

    const ref = "attachments/in-both-places";
    const bytes = Buffer.from([0x01, 0x02]);
    await fileStorage.upload({ key: ref, body: bytes, contentType: "image/png" });
    await db.execute(sql`
      insert into attachment_bytes (ref, bytes) values (${ref}, ${bytes})
      on conflict (ref) do update set bytes = excluded.bytes
    `);

    await fileStorage.remove(ref);

    assert.equal(bucket.has(`/test-attachments/${ref}`), false, "gone from the bucket");
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from attachment_bytes where ref = ${ref}`,
    );
    assert.equal(Number(rows[0]!.n), 0, "gone from the database too");
  });
});
