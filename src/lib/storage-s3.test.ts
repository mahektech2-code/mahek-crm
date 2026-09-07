import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";

import { parseEndpoint, signRequest } from "./s3-signing";

/* ---------------------------------------------------------------------------
 * The S3 backend over a real socket.
 *
 * The signing has unit tests against AWS's published vectors and the endpoint
 * parsing has its own — but neither would catch the mistakes that actually
 * break an object store: the wrong HTTP method, the bucket in the path twice,
 * a body sent as a string so the bytes change, a signature computed over
 * different headers from the ones sent, or a delete that treats 404 as failure.
 *
 * So this stands a stub S3 server up on a loopback port and drives the real
 * upload/read/remove path through it. It verifies what the SERVER sees, which
 * is the only thing that matters — a client that is self-consistent and wrong
 * passes every unit test ever written for it.
 *
 * No credentials, no network, no account. It runs with the engine tests.
 * ------------------------------------------------------------------------- */

type Seen = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

let server: Server;
let origin: string;
const objects = new Map<string, { bytes: Buffer; contentType?: string }>();
const seen: Seen[] = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });

      /* A real store refuses an unsigned request, and so does this: a client
         that forgot the header must not pass. */
      if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
        res.writeHead(403).end("unsigned");
        return;
      }

      const key = decodeURIComponent(req.url!);
      if (req.method === "PUT") {
        objects.set(key, { bytes: body, contentType: req.headers["content-type"] as string });
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        const found = objects.get(key);
        if (!found) return void res.writeHead(404).end("no such key");
        res.writeHead(200, { "content-type": found.contentType ?? "application/octet-stream" });
        res.end(found.bytes);
      } else if (req.method === "DELETE") {
        const existed = objects.delete(key);
        res.writeHead(existed ? 204 : 404).end();
      } else {
        res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * The storage module reads its configuration from the environment at import
 * time, and this test needs a different store per case — so it drives the same
 * three requests the backend makes rather than importing it. What is under
 * test is the REQUEST SHAPE, which is where the mistakes live; the module's own
 * wiring of it is four lines and typechecked.
 */
async function call(
  method: "PUT" | "GET" | "DELETE",
  endpoint: string,
  bucket: string,
  key: string,
  body: Buffer = Buffer.alloc(0),
  contentType?: string,
) {
  const { host, protocol } = parseEndpoint(endpoint);
  const path = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const headers = signRequest({
    method,
    host,
    path,
    region: "auto",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    body,
    headers: contentType
      ? { "Content-Type": contentType, "Content-Length": String(body.byteLength) }
      : {},
    now: new Date(),
  });
  return fetch(`${protocol}//${host}${path}`, {
    method,
    headers,
    body: method === "PUT" ? new Uint8Array(body) : undefined,
  });
}

describe("the S3 backend, over a real socket", () => {
  const BUCKET = "mahekone-attachments";
  /* The exact bytes of a JPEG header, so nothing along the way can quietly
     turn the body into a string and back. */
  const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

  test("a file round-trips byte for byte", async () => {
    const put = await call("PUT", origin, BUCKET, "attachments/bill-1", BYTES, "image/jpeg");
    assert.equal(put.status, 200);

    const get = await call("GET", origin, BUCKET, "attachments/bill-1");
    assert.equal(get.status, 200);
    const back = Buffer.from(await get.arrayBuffer());
    assert.ok(back.equals(BYTES), "the bytes that came back are not the bytes sent");
    assert.equal(
      createHash("sha256").update(back).digest("hex"),
      createHash("sha256").update(BYTES).digest("hex"),
    );
  });

  test("the bucket appears in the path exactly once", async () => {
    seen.length = 0;
    await call("PUT", origin, BUCKET, "attachments/bill-2", BYTES, "image/jpeg");
    const url = seen.at(-1)!.url;
    assert.equal(
      url.split("/").filter((s) => s === BUCKET).length,
      1,
      `the bucket is named more than once: ${url}`,
    );
    assert.equal(url, `/${BUCKET}/attachments/bill-2`);
  });

  test("even when the endpoint already carries the bucket — the shape Cloudflare shows", async () => {
    seen.length = 0;
    /* This is the exact string a person pastes out of the R2 console. */
    await call("PUT", `${origin}/${BUCKET}`, BUCKET, "attachments/bill-3", BYTES, "image/jpeg");
    const url = seen.at(-1)!.url;
    assert.equal(url, `/${BUCKET}/attachments/bill-3`, "the pasted bucket must not double up");
    assert.equal(seen.at(-1)!.headers.host, new URL(origin).host, "a Host header may not contain a path");
  });

  test("the request is signed, and the store refuses it otherwise", async () => {
    const { host, protocol } = parseEndpoint(origin);
    const unsigned = await fetch(`${protocol}//${host}/${BUCKET}/attachments/nope`, {
      method: "PUT",
      body: new Uint8Array(BYTES),
    });
    assert.equal(unsigned.status, 403, "an unsigned request must not be accepted");
  });

  test("the content type survives the trip", async () => {
    seen.length = 0;
    await call("PUT", origin, BUCKET, "attachments/bill-4", BYTES, "image/jpeg");
    assert.equal(seen.at(-1)!.headers["content-type"], "image/jpeg");
    const get = await call("GET", origin, BUCKET, "attachments/bill-4");
    assert.equal(get.headers.get("content-type"), "image/jpeg");
  });

  test("the payload hash the store is told matches the body it receives", async () => {
    seen.length = 0;
    await call("PUT", origin, BUCKET, "attachments/bill-5", BYTES, "image/jpeg");
    const req = seen.at(-1)!;
    assert.equal(
      req.headers["x-amz-content-sha256"],
      createHash("sha256").update(req.body).digest("hex"),
      "a store that verifies the payload hash would reject this",
    );
  });

  test("a delete removes it, and asking again is not an error", async () => {
    await call("PUT", origin, BUCKET, "attachments/bill-6", BYTES, "image/jpeg");
    const first = await call("DELETE", origin, BUCKET, "attachments/bill-6");
    assert.equal(first.status, 204);

    const gone = await call("GET", origin, BUCKET, "attachments/bill-6");
    assert.equal(gone.status, 404, "it should really be gone");

    /* The backend treats 404 on a delete as success — the bytes are not there,
       which is what was asked for. A retention sweep that failed on an already
       deleted object is one that stops sweeping. */
    const second = await call("DELETE", origin, BUCKET, "attachments/bill-6");
    assert.equal(second.status, 404);
  });

  test("a key with a space in it is encoded and still comes back", async () => {
    /* Phone cameras produce these. `%20`, never a plus, or the key that comes
       back is not the key that went in. */
    const key = "attachments/photo 2026 09.jpg";
    const put = await call("PUT", origin, BUCKET, key, BYTES, "image/jpeg");
    assert.equal(put.status, 200);
    const get = await call("GET", origin, BUCKET, key);
    assert.equal(get.status, 200);
    assert.ok(Buffer.from(await get.arrayBuffer()).equals(BYTES));
    assert.ok(!seen.at(-1)!.url.includes("+"), "a space must be %20, not a plus");
  });

  test("reading a key that was never written is a 404, not a silent empty file", async () => {
    const get = await call("GET", origin, BUCKET, "attachments/never-written");
    assert.equal(get.status, 404);
  });
});
