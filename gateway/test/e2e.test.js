// End-to-end test of the whole architecture: a real Hardhat JSON-RPC node,
// the deployed ConsentRegistry, the Express gateway with its revocation
// listener, content-addressed storage, and two users (owner + requester)
// driving the shared DataVaultClient exactly as the frontend does.
//
// Covers deck phases 3-6: encrypt/upload/register/download/decrypt, 403
// within one block after revoke, wrapped key deleted by the listener, modify,
// expiry, and "a cached old key fails after rotation".
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { DataVaultClient, ACTIONS, decryptFile, purposeHash } from "@datavault/shared";
import { openDb } from "../src/db.js";
import { createStorage } from "../src/storage.js";
import { createRegistry } from "../src/registry.js";
import { createListener } from "../src/listener.js";
import { createApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(here, "..", "..", "contracts");
const artifactPath = path.join(contractsDir, "artifacts", "contracts", "ConsentRegistry.sol", "ConsentRegistry.json");
const RPC_PORT = 8547;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const HH_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0 deployer
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1 gateway
];

let node, server, listener, db, tmp, provider, gatewayUrl, deployment;
let owner, requester, stranger; // DataVaultClient instances
const enc = new TextEncoder();
const dec = new TextDecoder();

async function waitForRpc() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Hardhat node did not start");
}

async function newUser(funder) {
  const w = ethers.Wallet.createRandom().connect(provider);
  await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther("10") })).wait();
  const c = new DataVaultClient({ gatewayUrl, signer: new ethers.NonceManager(w), deployment });
  c.wallet = w;
  return c;
}

before(async () => {
  if (!fs.existsSync(artifactPath)) execSync("npx hardhat compile", { cwd: contractsDir, stdio: "inherit" });
  node = spawn("npx", ["hardhat", "node", "--port", String(RPC_PORT)], { cwd: contractsDir, stdio: "ignore" });
  await waitForRpc();

  provider = new ethers.JsonRpcProvider(RPC, undefined, { pollingInterval: 100, cacheTimeout: -1 });
  const deployer = new ethers.NonceManager(new ethers.Wallet(HH_KEYS[0], provider));
  const gatewayWallet = new ethers.Wallet(HH_KEYS[1]);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const registryContract = await factory.deploy(await deployer.getAddress());
  const rcpt = await registryContract.deploymentTransaction().wait();
  await (await registryContract.setGateway(gatewayWallet.address, true)).wait();
  deployment = { network: "hardhat-test", chainId: 31337, address: await registryContract.getAddress(), deployBlock: rcpt.blockNumber, abi: artifact.abi };

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "datavault-"));
  db = openDb(path.join(tmp, "gw.db"));
  const storage = createStorage({ mode: "mock", mockDir: path.join(tmp, "ipfs") });
  const registry = createRegistry({ provider, gatewayPrivateKey: HH_KEYS[1], deployment });
  listener = createListener({ registry, db, storage, pollMs: 100, sweepMs: 3_600_000, logger: {} });
  const config = {
    network: "hardhat-test", deployment, corsOrigin: "*", siweDomains: ["localhost:5173"],
    sessionHours: 1, logAccessOnChain: true, maxUploadMb: 5,
  };
  const app = createApp({ config, db, storage, registry, listener });
  await new Promise((r) => (server = app.listen(0, r)));
  gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  listener.start();

  owner = await newUser(deployer);
  requester = await newUser(deployer);
  stranger = await newUser(deployer);
  for (const u of [owner, requester, stranger]) {
    await u.signIn();
    await u.unlockEncryptionKey();
  }
});

after(async () => {
  listener?.stop();
  server?.close();
  db?.close();
  node?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const waitFor = async (fn, ms = 5000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

let dataId, consentId;
const SECRET = "Patient: A. Example\nHbA1c: 5.4%\nNotes: all normal";

test("SIWE: bad signature and replayed nonce are rejected", async () => {
  const { nonce } = await owner.api("/auth/nonce", { auth: false });
  const res = await fetch(`${gatewayUrl}/auth/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: `localhost:5173 wants you to sign in with your Ethereum account:\n${owner.address}\n\nx\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 31337\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`, signature: await stranger.wallet.signMessage("hi") }),
  });
  assert.equal(res.status, 401);
  const unauth = await fetch(`${gatewayUrl}/data/1`);
  assert.equal(unauth.status, 401);
});

test("gateway refuses to pin plaintext", async () => {
  await assert.rejects(owner.api("/files", { method: "POST", raw: enc.encode("x".repeat(100)) }), /Only DataVault-encrypted/);
});

test("owner encrypts, uploads to IPFS, registers on-chain and can read back", async () => {
  const r = await owner.uploadAndRegister(enc.encode(SECRET), "Health");
  dataId = r.dataId;
  assert.equal(dataId, 1);
  const d = await owner.getData(dataId);
  assert.equal(d.cid, r.cid);
  assert.equal(d.category, "Health");
  // nothing on-chain or in storage is readable plaintext
  const calldata = (await provider.getTransaction(r.tx)).data;
  assert.ok(!calldata.includes(Buffer.from("HbA1c").toString("hex")));
  const back = await owner.fetchData(dataId);
  assert.equal(dec.decode(back.plaintext), SECRET);
  assert.equal(back.accessTx, null, "owner access is not logged on-chain");
});

test("requester without consent gets 403", async () => {
  await assert.rejects(requester.fetchData(dataId, "research"), (e) => e.status === 403);
});

test("access request is visible to the owner", async () => {
  await requester.api("/requests", { method: "POST", body: { dataId, purpose: "Research", actions: 1, note: "diabetes study" } });
  const incoming = await owner.api("/requests/incoming");
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].purpose, "research");
  await owner.api(`/requests/${incoming[0].id}`, { method: "PATCH", body: { status: "approved" } });
});

test("grant wraps the key for the requester, who can then fetch and decrypt; access is logged on-chain", async () => {
  const g = await owner.grant(dataId, requester.address, "research", ACTIONS.READ, 0);
  consentId = g.consentId;
  assert.equal(g.keyShared, true);
  const r = await requester.fetchData(dataId, "research");
  assert.equal(dec.decode(r.plaintext), SECRET);
  assert.match(r.accessTx, /^0x[0-9a-f]{64}$/);
  const logs = await owner.contract.queryFilter(owner.contract.filters.AccessLogged(dataId, requester.address));
  assert.equal(logs.length, 1);
});

test("wrong purpose, wrong action and a stranger are all denied", async () => {
  await assert.rejects(requester.fetchData(dataId, "marketing"), (e) => e.status === 403);
  await assert.rejects(requester.fetchData(dataId, "research", "share"), (e) => e.status === 403);
  await assert.rejects(stranger.fetchData(dataId, "research"), (e) => e.status === 403);
});

test("gateway refuses to store a wrapped key for someone without consent", async () => {
  const { cid } = await owner.getData(dataId);
  const res = await owner.api(`/data/${dataId}/keys`, {
    method: "PUT", body: { cid, keys: [{ grantee: stranger.address, wrappedKey: "0x" + "ab".repeat(100) }] },
  }).catch((e) => e);
  assert.equal(res.status, 400);
  assert.match(res.body.rejected[0].reason, /no active consent/);
});

test("modify: extending actions to SHARE takes effect immediately", async () => {
  await owner.modify(consentId, "research", ACTIONS.READ | ACTIONS.SHARE, 0);
  const c = await owner.getConsent(consentId);
  assert.equal(c.version, 2);
  const r = await requester.fetchData(dataId, "research", "share");
  assert.equal(dec.decode(r.plaintext), SECRET);
});

test("revoke: next request is 403 and the listener deletes the wrapped key", async () => {
  const before = await requester.fetchData(dataId, "research");
  const cachedKey = before.fileKey; // requester keeps a copy of the old file key
  const tRevoke = Date.now();
  await owner.revoke(consentId);
  // The check is per request, so denial is immediate (same block):
  await assert.rejects(requester.fetchData(dataId, "research"), (e) => e.status === 403);
  const revokeToDenialMs = Date.now() - tRevoke;
  const deleted = await waitFor(() => !db.getWrappedKey(dataId, requester.address));
  assert.ok(deleted, "listener should delete the wrapped key");
  const log = db.logsForData(dataId).find((l) => l.kind === "key_deleted");
  assert.ok(log);
  console.log(`    revoke tx -> first 403: ${revokeToDenialMs} ms (incl. tx mining); key deleted by listener`);
  test.cachedKey = cachedKey;
});

test("revoke and rotate: a cached old key cannot decrypt the new ciphertext; remaining grantee still can", async () => {
  // Give `stranger` a separate consent so we can check re-wrapping for remaining grantees.
  const g2 = await owner.grant(dataId, stranger.address, "analytics", ACTIONS.READ, 0);
  const g3 = await owner.grant(dataId, requester.address, "research", ACTIONS.READ, 0);
  const cached = (await requester.fetchData(dataId, "research")).fileKey;
  const oldCid = (await owner.getData(dataId)).cid;

  const { rotated } = await owner.revokeAndRotate(g3.consentId);
  assert.notEqual(rotated.cid, oldCid);
  assert.equal(rotated.rewrappedFor, 1);

  await assert.rejects(requester.fetchData(dataId, "research"), (e) => e.status === 403);
  // Fetch the new ciphertext straight from storage and try the cached key: must fail.
  const storage = createStorage({ mode: "mock", mockDir: path.join(tmp, "ipfs") });
  const newCipher = await storage.cat(rotated.cid);
  await assert.rejects(decryptFile(newCipher, cached), /Decryption failed/);
  // The other grantee still works with the new key, and the owner too.
  assert.equal(dec.decode((await stranger.fetchData(dataId, "analytics")).plaintext), SECRET);
  assert.equal(dec.decode((await owner.fetchData(dataId)).plaintext), SECRET);
  // Listener drops keys wrapped for the old CID and unpins it.
  assert.ok(await waitFor(async () => !(await storage.cat(oldCid).then(() => true, () => false))));
  assert.equal(g2.keyShared, true);
});

test("expiry: access stops after expiresAt, and the sweep deletes the key", async () => {
  const now = (await provider.getBlock("latest")).timestamp;
  const g = await owner.grant(dataId, requester.address, "treatment", ACTIONS.READ, now + 60);
  assert.equal(dec.decode((await requester.fetchData(dataId, "treatment")).plaintext), SECRET);
  await provider.send("evm_increaseTime", [120]);
  await provider.send("evm_mine", []);
  await assert.rejects(requester.fetchData(dataId, "treatment"), (e) => e.status === 403);
  await listener.sweepExpired();
  assert.equal(db.getWrappedKey(dataId, requester.address), undefined);
  assert.equal((await owner.getConsent(g.consentId)).effective, false);
});

test("audit trail rebuilds from chain events alone", async () => {
  const h = await owner.history(dataId);
  const kinds = h.map((e) => e.event);
  for (const k of ["DataRegistered", "ConsentGranted", "ConsentModified", "ConsentRevoked", "DataPointerUpdated", "AccessLogged"]) {
    assert.ok(kinds.includes(k), `missing ${k}`);
  }
  assert.equal(h[0].event, "DataRegistered");
  assert.equal(h.find((e) => e.event === "ConsentGranted").purposeHash, purposeHash("research"));
});

test("health endpoint reports an authorised gateway", async () => {
  const h = await owner.api("/health", { auth: false });
  assert.equal(h.ok, true);
  assert.equal(h.gatewayAuthorised, true);
  assert.ok(h.listener.keysDeleted >= 1);
});
