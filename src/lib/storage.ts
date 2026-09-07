import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { encodeS3Path, parseEndpoint, signRequest } from "./s3-signing";

/**
 * Where attachment bytes live.
 *
 * Two backends, and the app never knows which. Postgres is the default: no
 * second service, no token, no separate lifecycle, and the bytes sit in the
 * same backup and the same point-in-time restore as the record that refers to
 * them. For a few complaint photographs a week that is simpler in every way
 * that matters.
 *
 * An S3-compatible store takes over the moment one is configured, because
 * Postgres stops being the right answer at volume: bytes in the database are
 * bytes in every backup, every restore and every replica, and they are billed
 * as database storage rather than as file storage. The switch is the constant
 * at the bottom of this file and nothing else.
 *
 * There was a third backend, Vercel Blob, and it is gone. It was the right
 * answer while the app ran on Vercel; this deployment is a droplet with
 * Cloudflare R2, so the SDK was 916 KB of image weight that no code path could
 * reach — and the container registry being full is already what breaks deploys
 * here. Nothing migrates: a `stored_ref` names the store it was written to.
 *
 * Neither backend is ever read directly by a browser. Bytes come back through
 * /api/attachments/[id], which checks the caller can see the parent record.
 */

export type StoredFile = {
  /** Opaque reference. Never a URL, so nothing can be served directly. */
  ref: string;
  sizeBytes: number;
};

export interface FileStorage {
  upload(input: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
  }): Promise<StoredFile>;
  read(ref: string): Promise<ArrayBuffer>;
  remove(ref: string): Promise<void>;
  readonly kind: "postgres" | "s3";
}

/**
 * Bytes in their own table, never a column on `attachments`. A listing reads
 * filenames and sizes constantly; with the bytes alongside them, every such
 * read would drag megabytes through the connection pool to display a name.
 */
/**
 * Bytes out of `attachment_bytes`, or null where that table does not have them.
 *
 * Separate from the backend below because the S3 backend needs it too — see
 * the fallback in `s3Storage.read`. Null rather than a throw, so a caller can
 * ask "are they here?" without catching.
 */
async function readFromPostgres(ref: string): Promise<ArrayBuffer | null> {
  const rows = await db.execute<{ bytes: Buffer }>(
    sql`select bytes from attachment_bytes where ref = ${ref}`,
  );
  const row = rows[0];
  if (!row) return null;
  const buffer = Buffer.from(row.bytes);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

const postgresStorage: FileStorage = {
  kind: "postgres",
  async upload({ key, body }) {
    const buffer = Buffer.from(body);
    await db.execute(sql`
      insert into attachment_bytes (ref, bytes)
      values (${key}, ${buffer})
      on conflict (ref) do update set bytes = excluded.bytes
    `);
    return { ref: key, sizeBytes: buffer.byteLength };
  },
  async read(ref) {
    const bytes = await readFromPostgres(ref);
    if (!bytes) throw new Error("Attachment bytes are missing from storage.");
    return bytes;
  },
  async remove(ref) {
    await db.execute(sql`delete from attachment_bytes where ref = ${ref}`);
  },
};

/* ---------------------------------------------------------------------------
 * S3-compatible object storage — DigitalOcean Spaces, R2, MinIO, S3 itself.
 *
 * **This is the backend the travel and expense module needs.** Bill and
 * odometer photographs at field scale run to roughly 600 MB a month for a
 * small team, and bytes in Postgres are bytes in every backup, every restore
 * and every replica, billed as database storage. `AGENTS.md` already says
 * Postgres stops being right at volume; this module is what crosses that line.
 *
 * **Mahek already runs Cloudflare R2, so this needs no new supplier, no SDK
 * and no new bill.** R2 speaks the S3 API; so do Spaces, MinIO and S3 itself,
 * and this code cannot tell them apart. R2's two particulars — the region is
 * the literal word `auto`, and the endpoint carries the account id and NOT the
 * bucket — are written out in `.env.production.example`, because both produce
 * a bare 403 or 404 rather than anything naming the cause.
 *
 * Signing is `lib/s3-signing.ts`, hand-rolled against the published test
 * vectors rather than pulled in as an SDK — see the note there.
 * ------------------------------------------------------------------------- */

function s3Config() {
  /*
   * The credentials this deployment ALREADY has.
   *
   * `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_ENDPOINT` are set for
   * the offsite database backups (`deploy/backup.sh`). Attachments are the
   * same account and the same token, so turning this on is ONE new variable —
   * the bucket — rather than a second copy of a credential that then has to be
   * rotated in two places and will not be.
   *
   * `S3_*` overrides all of it, for a deployment on something that is not R2.
   */
  const s3Bucket = process.env.S3_BUCKET;
  const usingS3 = Boolean(s3Bucket ?? process.env.S3_ENDPOINT);
  const endpoint = usingS3 ? process.env.S3_ENDPOINT : process.env.R2_ENDPOINT;
  const accessKeyId = usingS3 ? process.env.S3_ACCESS_KEY_ID : process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = usingS3
    ? process.env.S3_SECRET_ACCESS_KEY
    : process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;

  const { host, bucketFromPath, protocol } = parseEndpoint(endpoint);
  /* The explicit variable wins, so somebody who has set both and changed their
     mind gets the one they last edited rather than the one buried in a URL. */
  const bucket = s3Bucket ?? process.env.R2_ATTACHMENTS_BUCKET ?? bucketFromPath;
  if (!bucket) return null;

  /*
   * **Never the backup bucket.** They are the same account and it is one
   * character to point at the wrong one — and the consequence is not a mess,
   * it is loss: the backup bucket has a retention policy that deletes old
   * objects, so every bill photograph would quietly disappear on a schedule
   * nobody associated with attachments. Refusing here means the store falls
   * back to Postgres, which is slow and correct, rather than to a bucket that
   * eats what it is given.
   */
  if (process.env.R2_BUCKET && bucket === process.env.R2_BUCKET) {
    console.error(
      "[storage] The attachments bucket is the same as R2_BUCKET, which is where database dumps go and which has a retention policy that deletes them. Attachments would be deleted on that schedule. Falling back to Postgres — give attachments their own bucket.",
    );
    return null;
  }

  return {
    bucket,
    host,
    protocol,
    /* R2 signs with the literal word `auto` and nothing else. A datacentre
       code here answers 403 and explains nothing. */
    region: process.env.S3_REGION ?? (usingS3 ? "us-east-1" : "auto"),
    accessKeyId,
    secretAccessKey,
  };
}

const s3Storage: FileStorage = {
  kind: "s3",
  async upload({ key, body, contentType }) {
    const config = s3Config()!;
    const buffer = Buffer.from(body);
    const path = `/${config.bucket}/${encodeS3Path(key)}`;
    const headers = signRequest({
      method: "PUT",
      host: config.host,
      path,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      body: buffer,
      /* No ACL header, so the object takes the bucket's default — which must
         be private. An unguessable public URL is still a URL that works for
         anybody who ends up with it: forwarded, logged by a proxy, pasted into
         a chat. Bytes are served by /api/attachments/[id] and nothing else. */
      headers: { "Content-Type": contentType, "Content-Length": String(buffer.byteLength) },
      now: new Date(),
    });

    const response = await fetch(`${config.protocol}//${config.host}${path}`, {
      method: "PUT",
      headers,
      body: new Uint8Array(buffer),
    });
    if (!response.ok) {
      throw new Error(
        `The file store refused the upload (${response.status}). ${await response.text().catch(() => "")}`.trim(),
      );
    }
    return { ref: key, sizeBytes: buffer.byteLength };
  },

  /**
   * The bytes, from the bucket — or from Postgres, where they predate it.
   *
   * **This fallback is what makes turning the bucket on a safe change rather
   * than a destructive one.** Everything uploaded before the switch lives in
   * `attachment_bytes`, and nothing migrates it: a complaint photograph from
   * March is still in the database. Without this, the day somebody sets the
   * bucket variable every existing payment proof, bill photograph and
   * check-in selfie stops opening — and it fails as a 404 on a screen, which
   * reads as "the file was lost" rather than "the store moved".
   *
   * The order is bucket first, because after the switch that is where almost
   * everything is and the fallback should be the rare path. It also means the
   * cost of the fallback is one 404 against R2, which is free.
   */
  async read(ref) {
    const config = s3Config()!;
    const path = `/${config.bucket}/${encodeS3Path(ref)}`;
    const headers = signRequest({
      method: "GET",
      host: config.host,
      path,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      body: Buffer.alloc(0),
      now: new Date(),
    });
    const response = await fetch(`${config.protocol}//${config.host}${path}`, {
      method: "GET",
      headers,
    }).catch(() => null);

    if (response?.ok) return response.arrayBuffer();

    const older = await readFromPostgres(ref);
    if (older) return older;

    throw new Error(
      `Attachment could not be read from storage. The bucket answered ${
        response ? response.status : "nothing"
      } and it is not in the database either.`,
    );
  },

  /**
   * Removed from both, because it may be in either.
   *
   * A retention sweep that deleted only from the bucket would leave every
   * pre-switch file in the database for ever — the rows would keep being
   * counted, backed up and restored long after the record that referred to
   * them was gone, which is the opposite of what retention is for.
   */
  async remove(ref) {
    const config = s3Config()!;
    const path = `/${config.bucket}/${encodeS3Path(ref)}`;
    const headers = signRequest({
      method: "DELETE",
      host: config.host,
      path,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      body: Buffer.alloc(0),
      now: new Date(),
    });
    const response = await fetch(`${config.protocol}//${config.host}${path}`, {
      method: "DELETE",
      headers,
    });
    /* 404 on a delete is success: the bytes are not there, which is what was
       asked for. Anything else is a store that is refusing us, and a retention
       sweep that silently fails is one nobody notices for a year. */
    if (!response.ok && response.status !== 404) {
      throw new Error(`The file store refused the delete (${response.status}).`);
    }
    await db.execute(sql`delete from attachment_bytes where ref = ${ref}`);
  },
};

/**
 * Which backend is in use.
 *
 * S3 first, because a deployment that has configured one has said what it
 * wants; Vercel Blob second, so an existing deployment keeps working
 * untouched; Postgres last, which is the default and is right until volume
 * says otherwise. Nothing migrates bytes between them — a `stored_ref` names
 * the store it was written to, so switching backends leaves old files where
 * they are and reads of them fail loudly rather than returning nothing.
 */
export const fileStorage: FileStorage = s3Config() ? s3Storage : postgresStorage;

export {
  sniffContentType,
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_UPLOAD_TYPES,
} from "./file-types";
