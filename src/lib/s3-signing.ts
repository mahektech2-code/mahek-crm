import { createHash, createHmac } from "node:crypto";

/* ---------------------------------------------------------------------------
 * Signature Version 4, by hand.
 *
 * **Why not the AWS SDK.** `@aws-sdk/client-s3` and its transitive dependencies
 * are tens of megabytes in the image, and this deployment's container registry
 * is a 500 MB quota that is already full — a failure that shows up as a
 * *skipped* deploy job rather than a red one, which is the worst way for it to
 * show up. Three requests (PUT, GET, DELETE) against one bucket do not justify
 * that, and the signing algorithm is about eighty lines.
 *
 * PURE, and that is what makes it safe to hand-roll: it takes a request and a
 * clock and returns headers, so the AWS-published test vectors run against it
 * with no network and no bucket. A wrong signature fails LOUDLY — the store
 * answers 403 and the upload errors — so the failure mode here is a broken
 * feature rather than a quiet hole.
 *
 * Written against the S3 API, so it works with anything that speaks it:
 * DigitalOcean Spaces, Cloudflare R2, MinIO, S3 itself.
 * ------------------------------------------------------------------------- */

const ALGORITHM = "AWS4-HMAC-SHA256";

export const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/**
 * Percent-encoding as S3 wants it for a path, which is NOT what
 * `encodeURIComponent` does: a slash stays a slash in a key, and the tilde must
 * NOT be encoded. Both differences produce a signature mismatch and nothing
 * else — no error naming the cause, just 403.
 */
export function encodeS3Path(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

export type SignInput = {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  /** Host only, no scheme: `blr1.digitaloceanspaces.com`. */
  host: string;
  /** Already-encoded path beginning with a slash: `/bucket/a/b.jpg`. */
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The body, or an empty buffer. Hashed whole — S3 requires it. */
  body: Buffer;
  /** Extra headers to sign. `host` and the two `x-amz-*` are added here. */
  headers?: Record<string, string>;
  /** Injected, so the test vectors are reproducible. */
  now: Date;
};

/** `20260907T041500Z` and `20260907`. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * The headers a signed request carries, including `Authorization`.
 *
 * Every header passed in is signed. That is deliberate rather than convenient:
 * a `Content-Type` that is sent but not signed is a header anybody in the
 * middle may change, and for an upload the content type is what the store will
 * later serve the bytes as.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const { amzDate, dateStamp } = stamps(input.now);
  const payloadHash = sha256Hex(input.body);

  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  /* Canonical headers are lower-cased, trimmed, and sorted by name. The values
     are collapsed on internal whitespace — an S3 rule that only ever bites on
     a filename with two spaces in it, which is exactly the sort of thing a
     salesman's phone produces. */
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((n) => {
      const key = Object.keys(headers).find((h) => h.toLowerCase() === n)!;
      return `${n}:${String(headers[key]).trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method,
    input.path,
    "", // no query string on any request this module makes
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    Authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Split an endpoint into the host to sign and the bucket, if it carries one.
 *
 * **Cloudflare's own console shows the S3 API as
 * `https://<account>.r2.cloudflarestorage.com/<bucket>`, and that is the string
 * a person pastes**, because it is the one they were given. Signing it as-is
 * puts a path into the `Host` header — which is not a host — and builds a URL
 * with the bucket in it twice. Neither produces an error naming the cause: it
 * is a 400 or a 404, on an upload, inside a request nobody is watching.
 *
 * So the bucket is taken FROM the endpoint where it appears there. A comment in
 * the example file was the previous defence and it is not one — the person
 * pasting the URL is not reading the file they are pasting it into.
 */
export function parseEndpoint(raw: string): {
  host: string;
  bucketFromPath: string | null;
  /** `https:` unless the endpoint says otherwise. Only a local store says otherwise. */
  protocol: "http:" | "https:";
} {
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    /* Not a URL at all. Hand back the trimmed string and let the request fail
       loudly rather than guessing at what was meant. */
    return {
      host: raw.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
      bucketFromPath: null,
      protocol: "https:",
    };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  /* The scheme is honoured rather than assumed. Every hosted store is https and
     that stays the default — but a self-hosted MinIO is often plain http, and
     so is the stub this module's own round-trip test runs against. Hard-coding
     https made the storage layer the one part of the app that could not be
     exercised over a real socket without a cloud account. */
  return {
    host: url.host,
    bucketFromPath: segments[0] ?? null,
    protocol: url.protocol === "http:" ? "http:" : "https:",
  };
}
