// DataVault protocol client. One implementation of the full flow (encrypt,
// upload, register, grant + key wrap, fetch + unwrap, modify, revoke, rotate)
// shared by the React frontend (MetaMask signer), the CLI and the tests
// (ethers.Wallet signer). Plaintext and file keys exist only inside this
// client, never at the gateway.
import { ethers } from "ethers";
import {
  generateFileKey, encryptFile, decryptFile, wrapKey, unwrapKey,
  deriveEncryptionKey, encryptionKeyMessage,
} from "./crypto.js";
import { purposeHash, normalisePurpose, CATEGORIES, STATUS, actionsToList } from "./constants.js";
import { buildSiweMessage } from "./siwe.js";

const b64ToBytes = (b64) =>
  typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(b64, "base64")) : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export class GatewayError extends Error {
  constructor(status, body) {
    super(body?.error ?? `Gateway error ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class DataVaultClient {
  /**
   * @param {object} o
   * @param {string} o.gatewayUrl   e.g. http://localhost:4000
   * @param {ethers.Signer} o.signer
   * @param {{address:string, abi:any[], chainId:number}} o.deployment
   * @param {string} [o.domain]     SIWE domain (host:port of the app)
   * @param {string} [o.uri]        SIWE uri
   */
  constructor({ gatewayUrl, signer, deployment, domain = "localhost:5173", uri = "http://localhost:5173" }) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.signer = signer;
    this.deployment = deployment;
    this.contract = new ethers.Contract(deployment.address, deployment.abi, signer);
    this.domain = domain;
    this.uri = uri;
    this.token = null;
    this.encKey = null; // { privateKey, publicKey } derived from a wallet signature
    this.address = null;
  }

  // ------------------------------------------------------------------ plumbing

  async api(path, { method = "GET", body, raw, auth = true } = {}) {
    const headers = {};
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload;
    if (raw) {
      headers["Content-Type"] = "application/octet-stream";
      payload = raw;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.gatewayUrl + path, { method, headers, body: payload });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GatewayError(res.status, json);
    return json;
  }

  /** Turn a contract revert into a readable error, e.g. "NotDataOwner(1, 0xabc…)". */
  decodeError(e) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof data === "string" && data.length >= 10) {
      try {
        const parsed = this.contract.interface.parseError(data);
        if (parsed) {
          const msg = `${parsed.name}(${parsed.args.map(String).join(", ")})`;
          const err = new Error(`Contract rejected the transaction: ${msg}`);
          err.shortMessage = err.message;
          err.revert = { name: parsed.name, args: [...parsed.args] };
          return err;
        }
      } catch {}
    }
    return e;
  }

  async #wait(txPromise) {
    let tx;
    try {
      tx = await txPromise;
    } catch (e) {
      throw this.decodeError(e);
    }
    const receipt = await tx.wait();
    const events = receipt.logs
      .map((l) => {
        try {
          return this.contract.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { hash: receipt.hash, gasUsed: receipt.gasUsed, events };
  }

  // ------------------------------------------------------------------ identity

  /** Sign-In with Ethereum (EIP-4361). */
  async signIn() {
    this.address = ethers.getAddress(await this.signer.getAddress());
    const { nonce } = await this.api("/auth/nonce", { auth: false });
    const message = buildSiweMessage({
      domain: this.domain,
      address: this.address,
      statement: "Sign in to DataVault. This proves you own this account and costs no gas.",
      uri: this.uri,
      chainId: Number(this.deployment.chainId),
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    const signature = await this.signer.signMessage(message);
    const s = await this.api("/auth/verify", { method: "POST", body: { message, signature }, auth: false });
    this.token = s.token;
    return s;
  }

  /** Derive this account's DataVault encryption key from a signature and publish the public half. */
  async unlockEncryptionKey() {
    this.address ??= ethers.getAddress(await this.signer.getAddress());
    const sig = await this.signer.signMessage(encryptionKeyMessage(this.address));
    this.encKey = deriveEncryptionKey(sig);
    await this.api("/keys/me", { method: "PUT", body: { publicKey: this.encKey.publicKey } });
    return this.encKey.publicKey;
  }

  async getPublicKeyOf(address) {
    try {
      return (await this.api(`/keys/${address}`, { auth: false })).publicKey;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  #needKey() {
    if (!this.encKey) throw new Error("Unlock your encryption key first");
  }

  // ------------------------------------------------------------------ owner: upload

  /** Encrypt in the client, pin ciphertext to IPFS via the gateway, register on-chain, store own wrapped key. */
  async uploadAndRegister(plaintext, category) {
    this.#needKey();
    const catIndex = typeof category === "number" ? category : CATEGORIES.indexOf(category);
    if (catIndex < 0) throw new Error(`Unknown category ${category}`);

    const fileKey = generateFileKey();
    const ciphertext = await encryptFile(plaintext, fileKey);
    const { cid, contentHash } = await this.api("/files", { method: "POST", raw: ciphertext });

    const r = await this.#wait(this.contract.registerData(cid, contentHash, catIndex));
    const ev = r.events.find((e) => e.name === "DataRegistered");
    const dataId = Number(ev.args.dataId);

    const ownKey = await wrapKey(fileKey, this.encKey.publicKey);
    await this.api(`/data/${dataId}/keys`, { method: "PUT", body: { cid, keys: [{ grantee: this.address, wrappedKey: ownKey }] } });
    return { dataId, cid, contentHash, tx: r.hash, gasUsed: r.gasUsed };
  }

  // ------------------------------------------------------------------ fetch (owner or requester)

  /** Ask the gateway for data. It checks isAccessAllowed on-chain first; 403 if not allowed. */
  async fetchData(dataId, purpose = "owner", action = "read") {
    this.#needKey();
    const q = new URLSearchParams({ purpose: normalisePurpose(purpose), action: String(action) });
    const r = await this.api(`/data/${dataId}?${q}`);
    const fileKey = await unwrapKey(r.wrappedKey, this.encKey.privateKey);
    const plaintext = await decryptFile(b64ToBytes(r.ciphertext), fileKey);
    return { ...r, plaintext, fileKey };
  }

  async #ownFileKey(dataId) {
    const r = await this.fetchData(dataId, "owner", "read");
    return { fileKey: r.fileKey, cid: r.cid, plaintext: r.plaintext };
  }

  // ------------------------------------------------------------------ owner: consent life cycle

  /** Grant on-chain, then wrap the file key for the requester (if they have published a public key). */
  async grant(dataId, requester, purpose, actions, expiresAt = 0) {
    const r = await this.#wait(
      this.contract.grantConsent(dataId, requester, purposeHash(purpose), actions, BigInt(expiresAt))
    );
    const consentId = Number(r.events.find((e) => e.name === "ConsentGranted").args.consentId);
    const keyShared = await this.shareKey(dataId, requester);
    return { consentId, tx: r.hash, gasUsed: r.gasUsed, keyShared };
  }

  /** (Re-)wrap the current file key for a grantee who has an active consent. */
  async shareKey(dataId, grantee) {
    this.#needKey();
    const pub = await this.getPublicKeyOf(grantee);
    if (!pub) return false;
    const { fileKey, cid } = await this.#ownFileKey(dataId);
    await this.api(`/data/${dataId}/keys`, {
      method: "PUT",
      body: { cid, keys: [{ grantee, wrappedKey: await wrapKey(fileKey, pub) }] },
    });
    return true;
  }

  async modify(consentId, purpose, actions, expiresAt = 0) {
    const r = await this.#wait(this.contract.modifyConsent(consentId, purposeHash(purpose), actions, BigInt(expiresAt)));
    return { tx: r.hash, gasUsed: r.gasUsed };
  }

  async revoke(consentId) {
    const r = await this.#wait(this.contract.revokeConsent(consentId));
    return { tx: r.hash, gasUsed: r.gasUsed };
  }

  /**
   * Revoke and rotate: revoke the consent, then re-encrypt the file with a
   * brand-new key, point the chain at the new ciphertext and re-wrap the new
   * key only for the owner and the grantees that still hold active consent.
   * A key the revoked party cached earlier cannot decrypt the new ciphertext.
   */
  async revokeAndRotate(consentId) {
    const c = await this.contract.getConsent(consentId);
    const revoked = await this.revoke(consentId);
    const rotated = await this.rotate(Number(c.dataId));
    return { revoked, rotated };
  }

  async rotate(dataId) {
    this.#needKey();
    const { plaintext } = await this.#ownFileKey(dataId);
    const newKey = generateFileKey();
    const ciphertext = await encryptFile(plaintext, newKey);
    const { cid, contentHash } = await this.api("/files", { method: "POST", raw: ciphertext });
    const r = await this.#wait(this.contract.updateDataPointer(dataId, cid, contentHash));

    const grantees = new Set();
    for (const id of await this.contract.getConsentIdsByData(dataId)) {
      if (await this.contract.isConsentEffective(id)) grantees.add((await this.contract.getConsent(id)).requester);
    }
    const keys = [{ grantee: this.address, wrappedKey: await wrapKey(newKey, this.encKey.publicKey) }];
    const missingKeys = [];
    for (const g of grantees) {
      const pub = await this.getPublicKeyOf(g);
      if (pub) keys.push({ grantee: g, wrappedKey: await wrapKey(newKey, pub) });
      else missingKeys.push(g);
    }
    await this.api(`/data/${dataId}/keys`, { method: "PUT", body: { cid, keys } });
    return { cid, tx: r.hash, gasUsed: r.gasUsed, rewrappedFor: keys.length - 1, missingKeys };
  }

  // ------------------------------------------------------------------ views

  async getData(dataId) {
    const d = await this.contract.getData(dataId);
    return {
      dataId: Number(dataId),
      owner: d.owner,
      category: CATEGORIES[Number(d.category)],
      pointerVersion: Number(d.pointerVersion),
      createdAt: Number(d.createdAt),
      contentHash: d.contentHash,
      cid: d.cid,
    };
  }

  async getConsent(consentId) {
    const c = await this.contract.getConsent(consentId);
    return {
      consentId: Number(consentId),
      dataId: Number(c.dataId),
      requester: c.requester,
      purposeHash: c.purpose,
      actions: Number(c.actions),
      actionList: actionsToList(c.actions),
      expiresAt: Number(c.expiresAt),
      version: Number(c.version),
      status: STATUS[Number(c.status)],
      updatedAt: Number(c.updatedAt),
      effective: await this.contract.isConsentEffective(consentId),
    };
  }

  async myData() {
    this.address ??= ethers.getAddress(await this.signer.getAddress());
    const ids = await this.contract.getDataIdsByOwner(this.address);
    return Promise.all(ids.map((id) => this.getData(id)));
  }

  async consentsForData(dataId) {
    const ids = await this.contract.getConsentIdsByData(dataId);
    return Promise.all(ids.map((id) => this.getConsent(id)));
  }

  async consentsGrantedToMe() {
    this.address ??= ethers.getAddress(await this.signer.getAddress());
    const ids = await this.contract.getConsentIdsByRequester(this.address);
    return Promise.all(ids.map((id) => this.getConsent(id)));
  }

  /** All data items on the registry (public metadata only: id, owner, category). */
  async catalog() {
    const n = Number(await this.contract.dataCount());
    const out = [];
    for (let i = 1; i <= n; i++) out.push(await this.getData(i));
    return out;
  }

  /** Readable audit trail for a data item, rebuilt from on-chain events only. */
  async history(dataId) {
    const c = this.contract;
    const from = this.deployment.deployBlock ?? 0;
    const filters = [
      c.filters.DataRegistered(dataId),
      c.filters.ConsentGranted(null, dataId),
      c.filters.ConsentModified(null, dataId),
      c.filters.ConsentRevoked(null, dataId),
      c.filters.DataPointerUpdated(dataId),
      c.filters.AccessLogged(dataId),
    ];
    const logs = (await Promise.all(filters.map((f) => c.queryFilter(f, from)))).flat();
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    const blockTimes = new Map();
    const out = [];
    for (const l of logs) {
      if (!blockTimes.has(l.blockNumber)) blockTimes.set(l.blockNumber, Number((await l.getBlock()).timestamp));
      const a = l.args;
      const row = { event: l.fragment.name, block: l.blockNumber, tx: l.transactionHash, time: blockTimes.get(l.blockNumber) };
      switch (l.fragment.name) {
        case "DataRegistered": Object.assign(row, { owner: a.owner, category: CATEGORIES[Number(a.category)], cid: a.cid }); break;
        case "ConsentGranted": Object.assign(row, { consentId: Number(a.consentId), requester: a.requester, purposeHash: a.purpose, actions: actionsToList(a.actions), expiresAt: Number(a.expiresAt) }); break;
        case "ConsentModified": Object.assign(row, { consentId: Number(a.consentId), requester: a.requester, purposeHash: a.purpose, actions: actionsToList(a.actions), expiresAt: Number(a.expiresAt), version: Number(a.version) }); break;
        case "ConsentRevoked": Object.assign(row, { consentId: Number(a.consentId), requester: a.requester }); break;
        case "DataPointerUpdated": Object.assign(row, { cid: a.cid, pointerVersion: Number(a.pointerVersion) }); break;
        case "AccessLogged": Object.assign(row, { requester: a.requester, purposeHash: a.purpose, actions: actionsToList(a.action), gateway: a.gateway }); break;
      }
      out.push(row);
    }
    return out;
  }
}
