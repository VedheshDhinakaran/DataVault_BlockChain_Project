import test from "node:test";
import assert from "node:assert/strict";
import {
  generateFileKey, encryptFile, decryptFile, sha256Hex, wrapKey, unwrapKey,
  deriveEncryptionKey, encryptionKeyMessage, isValidPublicKey, purposeHash,
  buildSiweMessage, parseSiweMessage, actionsToList,
} from "../src/index.js";

const enc = new TextEncoder();
const fakeSig = (n) => "0x" + String(n).repeat(130).slice(0, 130);

test("AES-256-GCM round trip and wrong-key failure", async () => {
  const key = generateFileKey();
  const pt = enc.encode("blood test results: all normal");
  const ct = await encryptFile(pt, key);
  assert.notDeepEqual(ct, pt);
  assert.deepEqual(await decryptFile(ct, key), pt);
  await assert.rejects(decryptFile(ct, generateFileKey()), /Decryption failed/);
});

test("tampered ciphertext is rejected", async () => {
  const key = generateFileKey();
  const ct = await encryptFile(enc.encode("hello"), key);
  ct[ct.length - 1] ^= 1;
  await assert.rejects(decryptFile(ct, key), /Decryption failed/);
});

test("ECIES key wrapping: only the grantee can unwrap", async () => {
  const alice = deriveEncryptionKey(fakeSig(1));
  const bob = deriveEncryptionKey(fakeSig(2));
  assert.ok(isValidPublicKey(alice.publicKey));
  const fileKey = generateFileKey();
  const wrapped = await wrapKey(fileKey, bob.publicKey);
  assert.deepEqual(await unwrapKey(wrapped, bob.privateKey), fileKey);
  await assert.rejects(unwrapKey(wrapped, alice.privateKey));
});

test("key derivation is deterministic", () => {
  assert.deepEqual(deriveEncryptionKey(fakeSig(3)), deriveEncryptionKey(fakeSig(3)));
  assert.notEqual(deriveEncryptionKey(fakeSig(3)).privateKey, deriveEncryptionKey(fakeSig(4)).privateKey);
  assert.match(encryptionKeyMessage("0xABC"), /Account: 0xabc/);
});

test("sha256Hex and purposeHash", () => {
  assert.equal(sha256Hex(enc.encode("abc")), "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // keccak256("research") must match ethers.id("research")
  assert.equal(purposeHash(" Research "), purposeHash("research"));
  assert.match(purposeHash("research"), /^0x[0-9a-f]{64}$/);
  assert.deepEqual(actionsToList(5), ["read", "process"]);
});

test("SIWE build/parse round trip", () => {
  const msg = buildSiweMessage({
    domain: "localhost:5173", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    uri: "http://localhost:5173", chainId: 31337, nonce: "abc123XYZ", issuedAt: "2026-01-01T00:00:00.000Z",
    expirationTime: "2026-01-02T00:00:00.000Z",
  });
  const p = parseSiweMessage(msg);
  assert.equal(p.domain, "localhost:5173");
  assert.equal(p.chainId, 31337);
  assert.equal(p.nonce, "abc123XYZ");
  assert.equal(p.expirationTime, "2026-01-02T00:00:00.000Z");
  assert.throws(() => parseSiweMessage("hello"));
});

test("packFile/unpackFile keep name and type inside the payload", async () => {
  const { packFile, unpackFile } = await import("../src/pack.js");
  const p = packFile(enc.encode("hello"), { name: "report.pdf", type: "application/pdf" });
  const u = unpackFile(p);
  assert.equal(u.name, "report.pdf");
  assert.equal(u.type, "application/pdf");
  assert.equal(new TextDecoder().decode(u.bytes), "hello");
  assert.equal(unpackFile(enc.encode("raw")).name, "data.bin");
});
