import "server-only";
import { put, del, get } from "@vercel/blob";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Where attachment bytes live.
 *
 * Two backends, and the app never knows which. Postgres is the default: no
 * second service, no token, no separate lifecycle, and the bytes sit in the
 * same backup and the same point-in-time restore as the record that refers to
 * them. For a few complaint photographs a week that is simpler in every way
 * that matters.
 *
 * Blob takes over the moment BLOB_READ_WRITE_TOKEN exists, because Postgres
 * stops being the right answer at volume: bytes in the database are bytes in
 * every backup, every restore and every replica, and they are billed as
 * database storage rather than as file storage. The switch is the constant at
 * the bottom of this file and nothing else.
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
  readonly kind: "postgres" | "blob";
}

/**
 * Bytes in their own table, never a column on `attachments`. A listing reads
 * filenames and sizes constantly; with the bytes alongside them, every such
 * read would drag megabytes through the connection pool to display a name.
 */
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
    const rows = await db.execute<{ bytes: Buffer }>(
      sql`select bytes from attachment_bytes where ref = ${ref}`,
    );
    const row = rows[0];
    if (!row) throw new Error("Attachment bytes are missing from storage.");
    const buffer = Buffer.from(row.bytes);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
  },
  async remove(ref) {
    await db.execute(sql`delete from attachment_bytes where ref = ${ref}`);
  },
};

const blobStorage: FileStorage = {
  kind: "blob",
  async upload({ key, body, contentType }) {
    // Private, not public-with-an-unguessable-name. An unguessable public URL
    // is still a URL that works for anyone who ends up with it — forwarded,
    // logged by a proxy, pasted into a chat.
    await put(key, Buffer.from(body), {
      access: "private",
      contentType,
      addRandomSuffix: false,
    });
    return { ref: key, sizeBytes: body.byteLength };
  },
  async read(ref) {
    const result = await get(ref, { access: "private" });
    if (!result || result.statusCode !== 200) {
      throw new Error("Attachment could not be read from storage.");
    }
    return new Response(result.stream).arrayBuffer();
  },
  async remove(ref) {
    await del(ref);
  },
};

export const fileStorage: FileStorage = process.env.BLOB_READ_WRITE_TOKEN
  ? blobStorage
  : postgresStorage;

export {
  sniffContentType,
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_UPLOAD_TYPES,
} from "./file-types";
