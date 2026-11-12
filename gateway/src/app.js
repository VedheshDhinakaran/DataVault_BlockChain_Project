import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import { ACTIONS, ALL_ACTIONS, CATEGORIES, purposeHash, normalisePurpose, sha256Hex, isValidPublicKey } from "@datavault/shared";
import { createAuth } from "./auth.js";

const FILE_MAGIC = Buffer.from("DVF1");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isHex = (s, min = 2) => typeof s === "string" && /^0x[0-9a-fA-F]+$/.test(s) && s.length >= min;

function parseAction(v) {
  if (v == null || v === "") return ACTIONS.READ;
  if (/^\d+$/.test(String(v))) return Number(v);
  const bit = ACTIONS[String(v).toUpperCase()];
  if (!bit) throw Object.assign(new Error(`Unknown action "${v}"`), { status: 400 });
  return bit;
}

export function createApp({ config, db, storage, registry, listener }) {
  const app = express();
  const { deployment } = config;
  const auth = createAuth({ db, chainId: deployment.chainId, siweDomains: config.siweDomains, sessionHours: config.sessionHours });
  const requireAuth = auth.middleware;

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));

  async function requireOwner(req, res) {
    const record = await registry.getData(req.params.dataId);
    if (!record) {
      res.status(404).json({ error: "Data not found" });
      return null;
    }
    if (record.owner.toLowerCase() !== req.wallet.toLowerCase()) {
      res.status(403).json({ error: "Only the data owner can do this" });
      return null;
    }
    return record;
  }

  // ------------------------------------------------------------ info
  app.get("/health", wrap(async (_req, res) => {
    res.json({
      ok: true,
      network: config.network,
      chainId: deployment.chainId,
      contract: deployment.address,
      gateway: registry.gatewayAddress,
      gatewayAuthorised: await registry.isAuthorisedGateway().catch(() => null),
      storage: storage.mode,
      storageReachable: await storage.health().catch(() => false),
      listener: listener?.stats ?? null,
    });
  }));

  // ------------------------------------------------------------ Sign-In with Ethereum
  app.get("/auth/nonce", (_req, res) => res.json({ nonce: auth.issueNonce() }));

  app.post("/auth/verify", (req, res) => {
    try {
      const { message, signature } = req.body ?? {};
      res.json(auth.verify(message, signature));
    } catch (e) {
      res.status(401).json({ error: e.message });
    }
  });

  app.get("/auth/me", requireAuth, (req, res) => res.json({ address: req.wallet }));

  app.post("/auth/logout", requireAuth, (req, res) => {
    db.deleteSession(req.sessionToken);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ encryption public keys
  app.put("/keys/me", requireAuth, (req, res) => {
    const { publicKey } = req.body ?? {};
    if (!isHex(publicKey) || !isValidPublicKey(publicKey)) return res.status(400).json({ error: "Invalid secp256k1 public key" });
    db.setPublicKey(req.wallet, publicKey);
    res.json({ address: req.wallet, publicKey });
  });

  app.get("/keys/:address", (req, res) => {
    if (!ethers.isAddress(req.params.address)) return res.status(400).json({ error: "Invalid address" });
    const publicKey = db.getPublicKey(req.params.address);
    if (!publicKey) return res.status(404).json({ error: "This account has not set up a DataVault encryption key yet" });
    res.json({ address: ethers.getAddress(req.params.address), publicKey });
  });

  // ------------------------------------------------------------ ciphertext upload (to IPFS)
  app.post(
    "/files",
    requireAuth,
    express.raw({ type: "application/octet-stream", limit: `${config.maxUploadMb}mb` }),
    wrap(async (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < FILE_MAGIC.length + 28) return res.status(400).json({ error: "Empty body" });
      // Refuse anything that is not DataVault ciphertext, so plaintext can never be pinned by mistake.
      if (!body.subarray(0, 4).equals(FILE_MAGIC)) return res.status(400).json({ error: "Only DataVault-encrypted files are accepted" });
      const bytes = new Uint8Array(body);
      const cid = await storage.add(bytes);
      db.log("uploaded", { address: req.wallet, detail: { cid, size: bytes.length } });
      res.json({ cid, contentHash: sha256Hex(bytes), size: bytes.length });
    })
  );

  // ------------------------------------------------------------ THE enforcement point
  // GET /data/:dataId?purpose=research&action=read
  app.get("/data/:dataId", requireAuth, wrap(async (req, res) => {
    const dataId = Number(req.params.dataId);
    const action = parseAction(req.query.action);
    const purpose = normalisePurpose(req.query.purpose ?? "");
    const pHash = purposeHash(purpose);

    const record = await registry.getData(dataId);
    if (!record) return res.status(404).json({ error: "Data not found" });
    const isOwner = record.owner.toLowerCase() === req.wallet.toLowerCase();

    const t0 = Date.now();
    const allowed = await registry.isAccessAllowed(dataId, req.wallet, pHash, action);
    const checkMs = Date.now() - t0;
    if (!allowed) {
      db.log("denied", { dataId, address: req.wallet, detail: { purpose, action } });
      return res.status(403).json({ error: "consent missing, expired or revoked", dataId, purpose, action });
    }

    const wk = db.getWrappedKey(dataId, req.wallet);
    if (!wk) {
      return res.status(409).json({ error: "Consent is valid but the owner has not shared a key with you yet" });
    }
    if (wk.cid !== record.cid) {
      return res.status(409).json({ error: "The data was re-encrypted; the owner must re-share the new key" });
    }

    const ciphertext = await storage.cat(record.cid);
    if (sha256Hex(ciphertext) !== record.contentHash) {
      return res.status(502).json({ error: "Integrity check failed: ciphertext hash does not match the chain" });
    }

    let accessTx = null;
    if (!isOwner && config.logAccessOnChain) {
      try {
        accessTx = await registry.logAccess(dataId, req.wallet, pHash, action);
      } catch (e) {
        // A revoke can land between the check and the log; never release in that case.
        db.log("denied", { dataId, address: req.wallet, detail: { purpose, action, reason: "logAccess failed" } });
        return res.status(403).json({ error: "consent missing, expired or revoked", detail: e.shortMessage ?? e.message });
      }
    }
    db.log("released", { dataId, address: req.wallet, detail: { purpose, action, accessTx, checkMs } });

    res.json({
      dataId,
      owner: record.owner,
      category: CATEGORIES[record.category],
      cid: record.cid,
      contentHash: record.contentHash,
      pointerVersion: record.pointerVersion,
      wrappedKey: wk.wrapped_key,
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      accessTx,
      checkMs,
    });
  }));

  // ------------------------------------------------------------ wrapped keys (owner only)
  // PUT /data/:dataId/keys  { cid, keys: [{ grantee, wrappedKey }] }
  app.put("/data/:dataId/keys", requireAuth, wrap(async (req, res) => {
    const record = await requireOwner(req, res);
    if (!record) return;
    const { cid, keys } = req.body ?? {};
    if (cid !== record.cid) return res.status(409).json({ error: "cid does not match the current on-chain pointer", onChainCid: record.cid });
    if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: "keys must be a non-empty array" });

    const stored = [];
    const rejected = [];
    for (const { grantee, wrappedKey } of keys) {
      if (!ethers.isAddress(grantee) || !isHex(wrappedKey, 2 + 2 * (33 + 12 + 32 + 16))) {
        rejected.push({ grantee, reason: "invalid grantee or wrappedKey" });
        continue;
      }
      const isOwnerKey = grantee.toLowerCase() === record.owner.toLowerCase();
      if (!isOwnerKey && !(await registry.hasEffectiveConsent(record.dataId, grantee))) {
        rejected.push({ grantee, reason: "no active consent on-chain for this grantee" });
        continue;
      }
      db.putWrappedKey(record.dataId, grantee, cid, wrappedKey);
      stored.push(ethers.getAddress(grantee));
    }
    if (!db.getPointer(record.dataId)) db.setPointer(record.dataId, record.cid);
    db.log("keys_stored", { dataId: record.dataId, address: req.wallet, detail: { cid, stored, rejected } });
    res.status(rejected.length && !stored.length ? 400 : 200).json({ stored, rejected });
  }));

  app.get("/data/:dataId/keys", requireAuth, wrap(async (req, res) => {
    const record = await requireOwner(req, res);
    if (!record) return;
    res.json({
      cid: record.cid,
      keys: db.listWrappedKeys(record.dataId).map((k) => ({
        grantee: ethers.getAddress(k.grantee),
        cid: k.cid,
        current: k.cid === record.cid,
        createdAt: k.created_at,
      })),
    });
  }));

  app.delete("/data/:dataId/keys/:grantee", requireAuth, wrap(async (req, res) => {
    const record = await requireOwner(req, res);
    if (!record) return;
    const deleted = db.deleteWrappedKey(record.dataId, req.params.grantee);
    db.log("key_deleted", { dataId: record.dataId, address: req.params.grantee, detail: { reason: "owner request", deleted } });
    res.json({ deleted });
  }));

  app.get("/data/:dataId/log", requireAuth, wrap(async (req, res) => {
    const record = await requireOwner(req, res);
    if (!record) return;
    res.json(db.logsForData(record.dataId).map((l) => ({ ...l, detail: l.detail ? JSON.parse(l.detail) : null })));
  }));

  // ------------------------------------------------------------ access requests (off-chain messages)
  app.post("/requests", requireAuth, wrap(async (req, res) => {
    const { dataId, purpose, actions = ACTIONS.READ, note } = req.body ?? {};
    const record = await registry.getData(dataId);
    if (!record) return res.status(404).json({ error: "Data not found" });
    if (!purpose || !String(purpose).trim()) return res.status(400).json({ error: "purpose is required" });
    if (!(actions >= 1 && actions <= ALL_ACTIONS)) return res.status(400).json({ error: "actions must be 1..7" });
    const id = db.addRequest({ dataId, requester: req.wallet, purpose: normalisePurpose(purpose), actions, note: note?.slice(0, 500) });
    res.status(201).json(db.getRequest(id));
  }));

  app.get("/requests/incoming", requireAuth, wrap(async (req, res) => {
    const ids = (await registry.contract.getDataIdsByOwner(req.wallet)).map(Number);
    res.json(db.requestsForData(ids));
  }));

  app.get("/requests/outgoing", requireAuth, (req, res) => res.json(db.requestsByRequester(req.wallet)));

  app.patch("/requests/:id", requireAuth, wrap(async (req, res) => {
    const r = db.getRequest(req.params.id);
    if (!r) return res.status(404).json({ error: "Request not found" });
    const record = await registry.getData(r.data_id);
    if (record.owner.toLowerCase() !== req.wallet.toLowerCase()) return res.status(403).json({ error: "Not your data" });
    const { status } = req.body ?? {};
    if (!["approved", "declined", "pending"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    db.setRequestStatus(r.id, status);
    res.json(db.getRequest(r.id));
  }));

  // ------------------------------------------------------------ errors
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.type === "entity.too.large" ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.shortMessage ?? err.message ?? "Internal error" });
  });

  return app;
}
