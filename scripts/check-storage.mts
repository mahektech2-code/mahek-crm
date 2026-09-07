/**
 * Prove the attachment store works, before real photographs depend on it.
 *
 *   npm run check:storage
 *
 * Writes one small file, reads it back, checks the bytes came home unchanged,
 * and deletes it. That is the whole round trip an attachment makes, so if this
 * passes the store is wired correctly — and if it fails it says which of the
 * three steps failed, which is the thing a 403 on its own never tells you.
 *
 * It is worth running BEFORE the switch matters. The failure mode otherwise is
 * silent for days: uploads throw inside a request nobody is watching, the
 * salesman sees "could not be stored", and the cause is a region string.
 */
import { fileStorage } from "../src/lib/storage";
import { db } from "../src/db";

/**
 * The Postgres pool is opened by importing the storage module — it is one of
 * the two backends — and an open pool keeps Node alive for ever. A script that
 * prints its answer and then hangs reads as a script that failed, so the exit
 * is explicit rather than left to the event loop draining.
 */
async function finish(code: number): Promise<never> {
  await db.$client.end().catch(() => {});
  process.exit(code);
}

const KEY = `attachments/_storage-check-${Date.now()}`;
/* A real JPEG header, so a store that sniffs content types is exercised the
   same way a bill photograph exercises it. */
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const backend = fileStorage.kind;
console.log(`Backend in use: ${backend}`);
if (backend === "postgres") {
  console.log(
    "\nThat is the default and it is fine until field photographs arrive.\n" +
      "To move them out of the database set R2_ATTACHMENTS_BUCKET — it reuses the\n" +
      "R2 credentials already set for backups. Give it its OWN bucket: the app\n" +
      "refuses to use R2_BUCKET, because that one's retention policy deletes\n" +
      "old objects and would take the bill photographs with them.",
  );
}

let wrote = false;
try {
  process.stdout.write("  upload … ");
  const stored = await fileStorage.upload({
    key: KEY,
    body: BYTES,
    contentType: "image/jpeg",
  });
  wrote = true;
  console.log(`ok (${stored.sizeBytes} bytes)`);

  process.stdout.write("  read back … ");
  const round = Buffer.from(await fileStorage.read(stored.ref));
  if (!round.equals(BYTES)) {
    console.log("FAILED");
    console.error(
      `\nThe bytes came back different: sent ${BYTES.length}, got ${round.length}.\n` +
        "A store that returns something other than what it was given is worse than\n" +
        "one that refuses — do not put photographs in it.",
    );
    await finish(1);
  }
  console.log("ok, byte for byte");

  process.stdout.write("  delete … ");
  await fileStorage.remove(stored.ref);
  wrote = false;
  console.log("ok");

  console.log(`\nThe ${backend} store round-trips. Attachments will work.`);
  await finish(0);
} catch (e) {
  console.log("FAILED");
  const message = e instanceof Error ? e.message : String(e);
  console.error(`\n${message}\n`);
  if (/403|SignatureDoesNotMatch|Forbidden/i.test(message)) {
    console.error(
      "A 403 is almost always one of three things, and none of them says so:\n" +
        "  - the region. R2 signs with the literal word `auto` and nothing else.\n" +
        "  - the endpoint. It carries the account id and NOT the bucket name.\n" +
        "  - the token's permissions. It needs Object Read & Write on this bucket.",
    );
  } else if (/404|NoSuchBucket|not found/i.test(message)) {
    console.error(
      "A 404 here usually means the bucket name is in the endpoint as well as in\n" +
        "R2_ATTACHMENTS_BUCKET. It belongs in one of them only.",
    );
  }
  if (wrote) {
    console.error(`\nA test object may be left behind at ${KEY}. It is 10 bytes.`);
  }
  await finish(1);
}
