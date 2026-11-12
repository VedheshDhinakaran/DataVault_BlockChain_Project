import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env") });

// Hardhat dev account #1: the default gateway signer on the LOCAL chain only.
const LOCAL_GATEWAY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export function loadDeployment(network) {
  const file = path.join(ROOT, "shared", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment for "${network}" at ${file}. Run: npm run deploy:local (or deploy:sepolia)`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const network = overrides.network ?? env.NETWORK ?? "localhost";
  const isLocal = network === "localhost" || network === "hardhat";
  const cfg = {
    network,
    port: Number(env.GATEWAY_PORT ?? 4000),
    rpcUrl: env.RPC_URL ?? (isLocal ? "http://127.0.0.1:8545" : env.SEPOLIA_RPC_URL),
    gatewayPrivateKey: env.GATEWAY_PRIVATE_KEY ?? (isLocal ? LOCAL_GATEWAY_KEY : undefined),
    dbPath: env.DB_PATH ?? path.join(ROOT, "gateway", "data", "gateway.db"),
    corsOrigin: (env.CORS_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((s) => s.trim()),
    siweDomains: (env.SIWE_DOMAINS ?? "localhost:5173,127.0.0.1:5173").split(",").map((s) => s.trim()),
    sessionHours: Number(env.SESSION_HOURS ?? 12),
    logAccessOnChain: (env.LOG_ACCESS_ONCHAIN ?? "true") === "true",
    pollMs: Number(env.EVENT_POLL_MS ?? (isLocal ? 1000 : 4000)),
    sweepMs: Number(env.EXPIRY_SWEEP_MS ?? 60000),
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 25),
    storage: {
      mode: env.IPFS_MODE ?? "mock", // kubo | pinata | mock
      kuboApiUrl: env.IPFS_API_URL ?? "http://127.0.0.1:5001",
      pinataJwt: env.PINATA_JWT,
      pinataGateway: env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud",
      mockDir: env.IPFS_MOCK_DIR ?? path.join(ROOT, "gateway", "data", "ipfs-mock"),
    },
    ...overrides,
  };
  if (!cfg.deployment) cfg.deployment = loadDeployment(network);
  if (!cfg.rpcUrl) throw new Error("RPC_URL (or SEPOLIA_RPC_URL) is not set");
  if (!cfg.gatewayPrivateKey) throw new Error("GATEWAY_PRIVATE_KEY is not set");
  return cfg;
}
