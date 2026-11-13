/**
 * THE VAULT'S PURE RULES — encryption and the identity graph, with no database.
 *
 * Crypto: a value round-trips; one tampered byte fails rather than returning
 * garbage (spec E2); every value has its own data key (E1); a KEK rotation
 * re-wraps without touching the ciphertext (E10); equal values share a
 * fingerprint and the fingerprint is not the value (§6.3).
 *
 * Graph: the blast radius is TRANSITIVE and survives a cycle (§14.5); a
 * personally controlled, no-2-step account with many dependants ranks first.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import * as crypto from "./crypto";
import * as graph from "./graph";

/* The vault reads its key from the environment at call time, so setting it here is enough. */
process.env.MBOS_JWT_SECRET = process.env.MBOS_JWT_SECRET || "test-app-secret-for-the-locker-vault";

describe("envelope encryption", () => {
  before(() => assert.ok(crypto.vaultReady(), "the test sets an app secret, so the vault has a key"));

  test("a value round-trips and the ciphertext does not contain it", () => {
    const plain = "Mahek@2026-razorpay-secret";
    const s = crypto.sealValue(plain);
    assert.ok(!s.ciphertext.includes(plain) && !s.wrappedDek.includes(plain));
    assert.ok(!Buffer.from(s.ciphertext.split(":")[2], "base64").toString("utf8").includes(plain));
    assert.equal(crypto.openValue(s), plain);
  });

  test("one changed byte of the ciphertext fails to decrypt — it never returns garbage", () => {
    const s = crypto.sealValue("bank transaction password");
    const [iv, tag, data] = s.ciphertext.split(":");
    const bytes = Buffer.from(data, "base64");
    bytes[0] ^= 0x01;
    assert.throws(() => crypto.openValue({ ...s, ciphertext: `${iv}:${tag}:${bytes.toString("base64")}` }));
  });

  test("a tampered wrapped key also fails", () => {
    const s = crypto.sealValue("x");
    const [iv, tag, data] = s.wrappedDek.split(":");
    const bytes = Buffer.from(data, "base64");
    bytes[3] ^= 0xff;
    assert.throws(() => crypto.openValue({ ...s, wrappedDek: `${iv}:${tag}:${bytes.toString("base64")}` }));
  });

  test("every value has its own data key, even when the values are equal", () => {
    const a = crypto.sealValue("same");
    const b = crypto.sealValue("same");
    assert.notEqual(a.wrappedDek, b.wrappedDek);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test("rotating the key-encryption key re-wraps the data key and leaves the ciphertext alone", () => {
    const s = crypto.sealValue("rotate me");
    assert.equal(s.kekVersion, 1);
    process.env.LOCKER_KEK = "a-new-separate-key-encryption-key";
    process.env.LOCKER_KEK_VERSION = "2";
    try {
      const r = crypto.rewrap(s);
      assert.equal(r.kekVersion, 2);
      assert.equal(r.ciphertext, s.ciphertext);
      assert.notEqual(r.wrappedDek, s.wrappedDek);
      assert.equal(crypto.openValue(r), "rotate me");
      /* The old row is still readable while the old key is configured. */
      assert.equal(crypto.openValue(s), "rotate me");
    } finally {
      delete process.env.LOCKER_KEK;
      delete process.env.LOCKER_KEK_VERSION;
    }
  });

  test("equal values share a fingerprint, different values do not, and it is not the value", () => {
    const a = crypto.fingerprint("hunter2-company");
    assert.equal(a, crypto.fingerprint("hunter2-company"));
    assert.notEqual(a, crypto.fingerprint("hunter3-company"));
    assert.ok(!a.includes("hunter"));
  });

  test("a list shows two characters, and nothing of a short value", () => {
    assert.equal(crypto.hintOf("abcdefghXY"), "XY");
    assert.equal(crypto.hintOf("1234"), "··");
  });
});

describe("the identity graph", () => {
  const I = (id: string, o: Partial<import("./graph").GIdentity> = {}): import("./graph").GIdentity => ({ id, email: `${id}@x`, provider: "Google", kind: "organisational", controlled: true, mfa: true, recovery: true, controlledByName: null, ...o });
  const Cr = (id: string, tier: "standard" | "sensitive" | "restricted" = "standard", identityId: string | null = null) => ({ id, title: id, tier, provider: id, identityId });

  test("the blast radius is transitive: losing an account loses the inbox whose login relied on it, and what relies on that inbox", () => {
    const ids = [I("root"), I("inbox")];
    const creds = [Cr("inboxLogin", "sensitive", "inbox"), Cr("do", "sensitive"), Cr("figma")];
    const links = [
      { credentialId: "inboxLogin", identityId: "root", kind: "Recovery email", sole: true },
      { credentialId: "do", identityId: "inbox", kind: "Shared sign-in", sole: true },
      { credentialId: "figma", identityId: "root", kind: "Shared sign-in", sole: false },
    ];
    const b = graph.blastRadius("root", ids, creds, links)!;
    assert.deepEqual(b.affected.map((a) => a.cred.id).sort(), ["do", "figma", "inboxLogin"]);
    assert.equal(b.affected.find((a) => a.cred.id === "do")!.depth, 2);
    assert.deepEqual(b.lostIdentities.map((i) => i.id), ["inbox"]);
  });

  test("a cycle ends", () => {
    const ids = [I("a"), I("b")];
    const creds = [Cr("aLogin", "standard", "a"), Cr("bLogin", "standard", "b")];
    const links = [
      { credentialId: "bLogin", identityId: "a", kind: "Recovery email", sole: true },
      { credentialId: "aLogin", identityId: "b", kind: "Recovery email", sole: true },
    ];
    const b = graph.blastRadius("a", ids, creds, links)!;
    assert.equal(b.affected.length, 2);
    assert.ok(graph.narrate(b).length > 0);
    assert.ok(graph.backupPlan(b, "Tester", "today").includes("NO OTHER WAY IN"));
  });

  test("a personal account with no 2-step sign-in and many dependants ranks first", () => {
    const ids = [I("company"), I("gmail", { controlled: false, mfa: false, recovery: false, kind: "personal", controlledByName: "Vinod" })];
    const creds = Array.from({ length: 6 }, (_, k) => Cr(`c${k}`, k % 2 ? "sensitive" : "standard"));
    const links = [
      ...creds.slice(0, 4).map((c) => ({ credentialId: c.id, identityId: "company", kind: "Shared sign-in", sole: false })),
      ...creds.slice(4).map((c) => ({ credentialId: c.id, identityId: "gmail", kind: "Shared sign-in", sole: true })),
    ];
    const ranked = graph.rankIdentities(ids, creds, links);
    assert.equal(ranked[0].identity.id, "gmail");
    /* 2 dependants × sensitive(3) × no-MFA 3 × personal 5 × no recovery 2 */
    assert.equal(ranked[0].score, 2 * 3 * 3 * 5 * 2);
    assert.match(graph.narrate(graph.blastRadius("gmail", ids, creds, links)!), /belongs to Vinod/);
  });
});
