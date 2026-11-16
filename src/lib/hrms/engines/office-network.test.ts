import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseIp, onOfficeNetwork, parseNetworkList } from "./office-network";

test("IPv4 matches exactly, and an IPv4 carried in IPv6 is the same address", () => {
  assert.equal(onOfficeNetwork("49.36.12.7", ["49.36.12.7"]), true);
  assert.equal(onOfficeNetwork("::ffff:49.36.12.7", ["49.36.12.7"]), true);
  assert.equal(onOfficeNetwork("49.36.12.8", ["49.36.12.7"]), false);
});

test("IPv6 matches on the /64, so every computer in the office is recognised", () => {
  const saved = ["2405:201:1:abcd:1111:2222:3333:4444"];
  assert.equal(onOfficeNetwork("2405:201:1:abcd:9:8:7:6", saved), true);
  assert.equal(onOfficeNetwork("2405:0201:0001:abcd::5", saved), true);
  assert.equal(onOfficeNetwork("2405:201:1:abce::5", saved), false);
});

test("no address, or nothing saved, is never the office", () => {
  assert.equal(onOfficeNetwork(null, ["1.2.3.4"]), false);
  assert.equal(onOfficeNetwork("1.2.3.4", []), false);
  assert.equal(onOfficeNetwork("1.2.3.4", null), false);
});

test("the typed list is cleaned, deduplicated, and a bad entry is named", () => {
  assert.deepEqual(parseNetworkList("49.36.12.7, 49.36.12.7\n2405:201::1"), { ok: true, ips: ["49.36.12.7", "2405:0201:0000:0000:0000:0000:0000:0001"] });
  assert.deepEqual(parseNetworkList(""), { ok: true, ips: [] });
  assert.deepEqual(parseNetworkList("49.36.12.7 office-wifi"), { ok: false, bad: "office-wifi" });
  assert.equal(normaliseIp("300.1.1.1"), null);
  assert.equal(normaliseIp("1:2:3"), null);
});
