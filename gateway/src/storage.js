// IPFS storage adapters. All of them store *ciphertext only*.
//   kubo   : a local IPFS (Kubo) node via its HTTP RPC API (default http://127.0.0.1:5001)
//   pinata : Pinata pinning service (needs PINATA_JWT)
//   mock   : content-addressed files on disk with real CIDv1 (raw, sha2-256); for tests and quick demos
import fs from "node:fs";
import path from "node:path";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

async function check(res, what) {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return res;
}

export function createStorage(cfg) {
  switch (cfg.mode) {
    case "kubo":
      return kuboStorage(cfg.kuboApiUrl);
    case "pinata":
      return pinataStorage(cfg.pinataJwt, cfg.pinataGateway);
    case "mock":
      return mockStorage(cfg.mockDir);
    default:
      throw new Error(`Unknown IPFS_MODE "${cfg.mode}" (use kubo, pinata or mock)`);
  }
}

function kuboStorage(api) {
  const base = api.replace(/\/$/, "") + "/api/v0";
  return {
    mode: "kubo",
    async add(bytes) {
      const form = new FormData();
      form.append("file", new Blob([bytes]), "datavault.bin");
      const res = await check(
        await fetch(`${base}/add?cid-version=1&raw-leaves=true&pin=true&quieter=true`, { method: "POST", body: form }),
        "IPFS add"
      );
      return (await res.json()).Hash;
    },
    async cat(cid) {
      const res = await check(await fetch(`${base}/cat?arg=${encodeURIComponent(cid)}`, { method: "POST" }), "IPFS cat");
      return new Uint8Array(await res.arrayBuffer());
    },
    async unpin(cid) {
      await fetch(`${base}/pin/rm?arg=${encodeURIComponent(cid)}`, { method: "POST" }).catch(() => {});
    },
    async health() {
      const res = await fetch(`${base}/id`, { method: "POST" });
      return res.ok;
    },
  };
}

function pinataStorage(jwt, gateway) {
  if (!jwt) throw new Error("IPFS_MODE=pinata requires PINATA_JWT");
  const auth = { Authorization: `Bearer ${jwt}` };
  return {
    mode: "pinata",
    async add(bytes) {
      const form = new FormData();
      form.append("file", new Blob([bytes]), "datavault.bin");
      form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
      const res = await check(
        await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: auth, body: form }),
        "Pinata pin"
      );
      return (await res.json()).IpfsHash;
    },
    async cat(cid) {
      const res = await check(await fetch(`${gateway.replace(/\/$/, "")}/ipfs/${cid}`), "IPFS gateway fetch");
      return new Uint8Array(await res.arrayBuffer());
    },
    async unpin(cid) {
      await fetch(`https://api.pinata.cloud/pinning/unpin/${cid}`, { method: "DELETE", headers: auth }).catch(() => {});
    },
    async health() {
      const res = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: auth });
      return res.ok;
    },
  };
}

function mockStorage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (cid) => {
    const c = CID.parse(cid).toString(); // validates and normalises
    return path.join(dir, c);
  };
  return {
    mode: "mock",
    async add(bytes) {
      const cid = CID.create(1, raw.code, await sha256.digest(bytes)).toString();
      fs.writeFileSync(file(cid), bytes);
      return cid;
    },
    async cat(cid) {
      const f = file(cid);
      if (!fs.existsSync(f)) throw new Error(`CID not found: ${cid}`);
      return new Uint8Array(fs.readFileSync(f));
    },
    async unpin(cid) {
      fs.rmSync(file(cid), { force: true });
    },
    async health() {
      return true;
    },
  };
}
