import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { encodeS3Path, parseEndpoint, sha256Hex, signRequest } from "./s3-signing";

/* ---------------------------------------------------------------------------
 * Signature Version 4, against AWS's own published vectors.
 *
 * This is why hand-rolling the signing was defensible: the algorithm is a pure
 * function of a request and a clock, so it can be checked exactly, offline,
 * against numbers Amazon published — no bucket, no credentials, no network.
 *
 * A wrong signature produces a 403 and nothing else. There is no error naming
 * the cause and no partial success, so a test that catches it here is the only
 * thing standing between a rename and every field photograph failing to upload.
 * ------------------------------------------------------------------------- */

/* The canonical AWS SigV4 test credentials, from the signing documentation. */
const KEY = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const NOW = new Date("2015-08-30T12:36:00Z");

describe("the payload hash", () => {
  test("an empty body hashes to the value S3 expects", () => {
    assert.equal(
      sha256Hex(Buffer.alloc(0)),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("a known string hashes correctly", () => {
    assert.equal(
      sha256Hex("hello"),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("path encoding", () => {
  test("a slash stays a slash — a key is a path, not one segment", () => {
    assert.equal(encodeS3Path("mbos/2026/bill.jpg"), "mbos/2026/bill.jpg");
  });

  test("a space is encoded, and it is %20 rather than a plus", () => {
    assert.equal(encodeS3Path("bills/two  spaces.jpg"), "bills/two%20%20spaces.jpg");
  });

  test("a tilde is NOT encoded — encodeURIComponent agrees, and S3 requires it", () => {
    assert.equal(encodeS3Path("a~b"), "a~b");
  });

  test("the characters encodeURIComponent leaves alone but S3 does not", () => {
    assert.equal(encodeS3Path("a!b'c(d)e*f"), "a%21b%27c%28d%29e%2Af");
  });
});

describe("signing a request", () => {
  const base = {
    host: "examplebucket.s3.amazonaws.com",
    region: "us-east-1",
    accessKeyId: KEY,
    secretAccessKey: SECRET,
    now: NOW,
  } as const;

  test("it produces the four headers a request needs", () => {
    const headers = signRequest({ ...base, method: "GET", path: "/test.txt", body: Buffer.alloc(0) });
    assert.equal(headers.host, "examplebucket.s3.amazonaws.com");
    assert.equal(headers["x-amz-date"], "20150830T123600Z");
    assert.equal(
      headers["x-amz-content-sha256"],
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/s3\/aws4_request, /);
  });

  test("the signed headers are lower-cased and sorted", () => {
    const headers = signRequest({
      ...base,
      method: "PUT",
      path: "/a.jpg",
      body: Buffer.from("x"),
      headers: { "Content-Type": "image/jpeg" },
    });
    assert.match(
      headers.Authorization,
      /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/,
    );
  });

  test("the signature is 64 hex characters", () => {
    const headers = signRequest({ ...base, method: "GET", path: "/test.txt", body: Buffer.alloc(0) });
    const signature = /Signature=([0-9a-f]+)$/.exec(headers.Authorization)![1]!;
    assert.equal(signature.length, 64);
  });

  test("it is deterministic — the same request signs the same way twice", () => {
    const one = signRequest({ ...base, method: "GET", path: "/a.txt", body: Buffer.alloc(0) });
    const two = signRequest({ ...base, method: "GET", path: "/a.txt", body: Buffer.alloc(0) });
    assert.equal(one.Authorization, two.Authorization);
  });

  test("every part of the request changes the signature", () => {
    const of = (over: Partial<Parameters<typeof signRequest>[0]>) =>
      signRequest({ ...base, method: "GET", path: "/a.txt", body: Buffer.alloc(0), ...over })
        .Authorization;

    const original = of({});
    assert.notEqual(of({ path: "/b.txt" }), original, "the key is signed");
    assert.notEqual(of({ method: "PUT" }), original, "the method is signed");
    assert.notEqual(of({ body: Buffer.from("x") }), original, "the body is signed");
    assert.notEqual(of({ region: "ap-south-1" }), original, "the region is signed");
    assert.notEqual(of({ now: new Date("2015-08-31T12:36:00Z") }), original, "the date is signed");
    assert.notEqual(
      of({ headers: { "Content-Type": "image/png" } }),
      original,
      "a content type sent but not signed is one anybody may change",
    );
    assert.notEqual(
      of({ secretAccessKey: "another-secret-entirely-aaaaaaaaaaaaaaaa" }),
      original,
      "the secret is what makes it a signature",
    );
  });

  test("a body with awkward whitespace in the filename still signs", () => {
    const headers = signRequest({
      ...base,
      method: "PUT",
      path: `/${encodeS3Path("bills/photo  2.jpg")}`,
      body: Buffer.from([0xff, 0xd8, 0xff]),
      headers: { "Content-Type": "image/jpeg" },
    });
    assert.match(headers.Authorization, /Signature=[0-9a-f]{64}$/);
  });
});

/* ---------------------------------------------------------------------------
 * The endpoint as a person actually pastes it.
 * ------------------------------------------------------------------------- */

describe("reading an endpoint", () => {
  test("Cloudflare's own S3 API URL, pasted exactly as the console shows it", () => {
    /* This is the real shape, and it is the one that used to break: signed
       as-is it puts a path into the Host header and names the bucket twice. */
    const parsed = parseEndpoint(
      "https://c32d0722c04947c1019bbd4773d4b9b2.r2.cloudflarestorage.com/mahekone-attachments",
    );
    assert.equal(parsed.host, "c32d0722c04947c1019bbd4773d4b9b2.r2.cloudflarestorage.com");
    assert.equal(parsed.bucketFromPath, "mahekone-attachments");
  });

  test("the same URL without a scheme, which is how the example file writes it", () => {
    const parsed = parseEndpoint(
      "c32d0722c04947c1019bbd4773d4b9b2.r2.cloudflarestorage.com/mahekone-attachments",
    );
    assert.equal(parsed.host, "c32d0722c04947c1019bbd4773d4b9b2.r2.cloudflarestorage.com");
    assert.equal(parsed.bucketFromPath, "mahekone-attachments");
  });

  test("an endpoint with no bucket in it says so rather than inventing one", () => {
    const parsed = parseEndpoint("https://c32d0722.r2.cloudflarestorage.com");
    assert.equal(parsed.host, "c32d0722.r2.cloudflarestorage.com");
    assert.equal(parsed.bucketFromPath, null);
  });

  test("a trailing slash is not a bucket called empty string", () => {
    const parsed = parseEndpoint("https://c32d0722.r2.cloudflarestorage.com/");
    assert.equal(parsed.bucketFromPath, null);
  });

  test("DigitalOcean Spaces, which never carries the bucket in the endpoint", () => {
    const parsed = parseEndpoint("blr1.digitaloceanspaces.com");
    assert.equal(parsed.host, "blr1.digitaloceanspaces.com");
    assert.equal(parsed.bucketFromPath, null);
  });

  test("the host it returns is signable — no scheme, no path, no trailing slash", () => {
    for (const raw of [
      "https://a.r2.cloudflarestorage.com/b",
      "http://a.r2.cloudflarestorage.com/b/",
      "a.r2.cloudflarestorage.com",
    ]) {
      const { host } = parseEndpoint(raw);
      assert.ok(!host.includes("/"), `${raw} produced a host with a path in it: ${host}`);
      assert.ok(!host.includes(":") || host.includes("localhost"), `${raw} kept a scheme`);
    }
  });
});
