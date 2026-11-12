#!/usr/bin/env node
// DataVault command-line client (deck phase 3: "encrypt, upload, register,
// download and decrypt from the command line"). Uses the same protocol
// client as the web app.
//
//   node scripts/cli.js <command> [args] --key <privateKey> [--gateway URL] [--network localhost]
//
// Commands:
//   upload  <file> --category Health|Finance|Education|Location|Other
//   grant   <dataId> <requester> --purpose research [--actions 1] [--expires-in 3600]
//   modify  <consentId> --purpose research [--actions 3] [--expires-in 0]
//   revoke  <consentId> [--rotate]
//   fetch   <dataId> --purpose research [--action read] [--out file]
//   list                       (my data and consents granted to me)
//   history <dataId>
//
// The private key can also come from DV_PRIVATE_KEY. On the local chain you
// can use Hardhat's printed dev keys.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { ethers } from "ethers";
import path from "node:path";
import { DataVaultClient, CATEGORIES, packFile, unpackFile } from "@datavault/shared";
import { loadDeployment } from "../src/config.js";

const { values: o, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: "string" },
    gateway: { type: "string", default: process.env.GATEWAY_URL ?? "http://localhost:4000" },
    network: { type: "string", default: process.env.NETWORK ?? "localhost" },
    rpc: { type: "string" },
    category: { type: "string", default: "Other" },
    purpose: { type: "string", default: "research" },
    actions: { type: "string", default: "1" },
    action: { type: "string", default: "read" },
    "expires-in": { type: "string", default: "0" },
    out: { type: "string" },
    rotate: { type: "boolean", default: false },
  },
});

const usage = () => {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
};
if (!cmd) usage();

const deployment = loadDeployment(o.network);
const rpc = o.rpc ?? process.env.RPC_URL ?? (o.network === "localhost" ? "http://127.0.0.1:8545" : process.env.SEPOLIA_RPC_URL);
const pk = o.key ?? process.env.DV_PRIVATE_KEY;
if (!pk) throw new Error("Pass --key <privateKey> or set DV_PRIVATE_KEY");
const provider = new ethers.JsonRpcProvider(rpc);
const signer = new ethers.NonceManager(new ethers.Wallet(pk, provider));
const dv = new DataVaultClient({ gatewayUrl: o.gateway, signer, deployment });

try {
await dv.signIn();
await dv.unlockEncryptionKey();
console.log(`Signed in as ${dv.address}`);

const expiresAt = async () => {
  const s = Number(o["expires-in"]);
  return s > 0 ? Number((await provider.getBlock("latest")).timestamp) + s : 0;
};

switch (cmd) {
  case "upload": {
    if (!CATEGORIES.includes(o.category)) throw new Error(`category must be one of ${CATEGORIES.join(", ")}`);
    const bytes = packFile(new Uint8Array(fs.readFileSync(args[0])), { name: path.basename(args[0]) });
    const r = await dv.uploadAndRegister(bytes, o.category);
    console.log(`Encrypted and registered as dataId ${r.dataId}\n  cid  ${r.cid}\n  hash ${r.contentHash}\n  tx   ${r.tx} (gas ${r.gasUsed})`);
    break;
  }
  case "grant": {
    const r = await dv.grant(Number(args[0]), args[1], o.purpose, Number(o.actions), await expiresAt());
    console.log(`Consent ${r.consentId} granted (tx ${r.tx}, gas ${r.gasUsed}).`);
    console.log(r.keyShared ? "File key wrapped for the requester." : "Requester has no encryption key yet; run `grant` again later or share from the web app.");
    break;
  }
  case "modify": {
    const r = await dv.modify(Number(args[0]), o.purpose, Number(o.actions), await expiresAt());
    console.log(`Consent ${args[0]} modified (tx ${r.tx}, gas ${r.gasUsed}).`, await dv.getConsent(Number(args[0])));
    break;
  }
  case "revoke": {
    if (o.rotate) {
      const r = await dv.revokeAndRotate(Number(args[0]));
      console.log(`Revoked (tx ${r.revoked.tx}) and rotated to ${r.rotated.cid}; key re-wrapped for ${r.rotated.rewrappedFor} remaining grantee(s).`);
    } else {
      const r = await dv.revoke(Number(args[0]));
      console.log(`Consent ${args[0]} revoked (tx ${r.tx}, gas ${r.gasUsed}).`);
    }
    break;
  }
  case "fetch": {
    try {
      const r = await dv.fetchData(Number(args[0]), o.purpose, o.action);
      const file = unpackFile(r.plaintext);
      if (o.out) fs.writeFileSync(o.out, file.bytes);
      else process.stdout.write(Buffer.from(file.bytes).toString("utf8") + "\n");
      console.error(`File: ${file.name} (${file.bytes.length} bytes)`);
      console.error(`Released by gateway (check ${r.checkMs} ms${r.accessTx ? `, logged in ${r.accessTx}` : ""}).`);
    } catch (e) {
      console.error(`Denied: HTTP ${e.status ?? "?"} ${e.message}`);
      process.exitCode = 2;
    }
    break;
  }
  case "list": {
    console.log("My data:");
    console.table(await dv.myData());
    console.log("Consents granted to me:");
    console.table((await dv.consentsGrantedToMe()).map(({ actionList, ...c }) => ({ ...c, actions: actionList.join("+") })));
    break;
  }
  case "history": {
    console.table((await dv.history(Number(args[0]))).map((e) => ({ ...e, actions: e.actions?.join("+"), time: new Date(e.time * 1000).toISOString() })));
    break;
  }
  default:
    usage();
}
} catch (e) {
  console.error(`Error: ${e?.shortMessage ?? e?.message ?? e}`);
  process.exitCode = 1;
}
