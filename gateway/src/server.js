import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createStorage } from "./storage.js";
import { createRegistry } from "./registry.js";
import { createListener } from "./listener.js";
import { createApp } from "./app.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const storage = createStorage(config.storage);
const registry = createRegistry({ ...config, pollMs: config.pollMs });
const listener = createListener({ registry, db, storage, pollMs: config.pollMs, sweepMs: config.sweepMs });
const app = createApp({ config, db, storage, registry, listener });

const chainId = Number((await registry.provider.getNetwork()).chainId);
if (chainId !== Number(config.deployment.chainId)) {
  console.error(`RPC is on chain ${chainId} but the deployment is for ${config.deployment.chainId}`);
  process.exit(1);
}
if (!(await registry.isAuthorisedGateway())) {
  console.warn(`WARNING: ${registry.gatewayAddress} is not an authorised gateway; logAccess will fail. Re-run the deploy script or call setGateway.`);
}

listener.start();
app.listen(config.port, () => {
  console.log(`DataVault Access Gateway on http://localhost:${config.port}`);
  console.log(`  network   ${config.network} (chain ${chainId})`);
  console.log(`  contract  ${config.deployment.address}`);
  console.log(`  gateway   ${registry.gatewayAddress}`);
  console.log(`  storage   ${storage.mode}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    listener.stop();
    db.close();
    process.exit(0);
  });
}
