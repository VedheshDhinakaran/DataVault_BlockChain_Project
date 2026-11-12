// Evaluation script (deck slide 18): gas per consent operation and
// "loop vs mapping" latency of the access check as consents grow.
//
//   npx hardhat run scripts/benchmark.js            (in-process Hardhat network)
//   npx hardhat run scripts/benchmark.js --network localhost
const { ethers } = require("hardhat");

const READ = 1;
const p = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function gasOf(txPromise) {
  const r = await (await txPromise).wait();
  return Number(r.gasUsed);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function timeCall(fn, runs = 30) {
  const t = [];
  for (let i = 0; i < runs; i++) {
    const s = process.hrtime.bigint();
    await fn();
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  return median(t);
}

async function main() {
  const [admin, owner, requester, gateway] = await ethers.getSigners();
  const Registry = await ethers.getContractFactory("ConsentRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();
  await (await registry.setGateway(gateway.address, true)).wait();
  const R = registry.connect(owner);

  // ---- gas per operation ----
  const gas = {};
  gas.registerData = await gasOf(R.registerData("bafkreiexamplecid", p("ct"), 0));
  gas.grantConsent = await gasOf(R.grantConsent(1, requester.address, p("research"), READ, 0));
  gas.modifyConsent = await gasOf(R.modifyConsent(1, p("research"), 3, 0));
  gas.modifyConsentPurpose = await gasOf(R.modifyConsent(1, p("analytics"), 3, 0));
  gas.logAccess = await gasOf(registry.connect(gateway).logAccess(1, requester.address, p("analytics"), READ));
  gas.updateDataPointer = await gasOf(R.updateDataPointer(1, "bafkreirotatedcid", p("ct2")));
  gas.revokeConsent = await gasOf(R.revokeConsent(1));
  console.log("\nGas used per operation");
  console.table(gas);

  // ---- loop vs mapping as consents grow ----
  const rows = [];
  let dataId = 1;
  for (const n of [1, 10, 100]) {
    await (await R.registerData(`bafkreidata${n}`, p(`ct${n}`), 4)).wait();
    dataId++;
    const wallets = [];
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom().address;
      wallets.push(w);
      await (await R.grantConsent(dataId, w, p("research"), READ, 0)).wait();
    }
    const target = wallets[wallets.length - 1]; // worst case for the scan
    const mapGas = Number(await registry.isAccessAllowed.estimateGas(dataId, target, p("research"), READ));
    const scanGas = Number(await registry.isAccessAllowedByScan.estimateGas(dataId, target, p("research"), READ));
    const mapMs = await timeCall(() => registry.isAccessAllowed(dataId, target, p("research"), READ));
    const scanMs = await timeCall(() => registry.isAccessAllowedByScan(dataId, target, p("research"), READ));
    rows.push({ consents: n, mappingGas: mapGas, scanGas, mappingMedianMs: +mapMs.toFixed(3), scanMedianMs: +scanMs.toFixed(3) });
  }
  console.log("\nisAccessAllowed: mapping (used) vs linear scan (reference), worst case");
  console.table(rows);
  console.log("Gas for view calls is the estimate a contract caller would pay; off-chain eth_call is free.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
