// Deploys ConsentRegistry, authorises the Access Gateway and writes the
// address + ABI to shared/deployments/<network>.json so the gateway and the
// frontend can find the contract.
//
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

// Hardhat's well-known dev account #1. Used as the gateway signer on the
// local chain only. NEVER use it on a public network.
const LOCAL_GATEWAY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const isLocal = ["hardhat", "localhost"].includes(network.name);

  let gatewayAddress = process.env.GATEWAY_ADDRESS;
  if (!gatewayAddress && process.env.GATEWAY_PRIVATE_KEY) {
    gatewayAddress = new ethers.Wallet(process.env.GATEWAY_PRIVATE_KEY).address;
  }
  if (!gatewayAddress && isLocal) gatewayAddress = new ethers.Wallet(LOCAL_GATEWAY_KEY).address;
  if (!gatewayAddress) throw new Error("Set GATEWAY_PRIVATE_KEY or GATEWAY_ADDRESS in .env for this network");

  console.log(`Network:  ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const Registry = await ethers.getContractFactory("ConsentRegistry");
  const registry = await Registry.deploy(deployer.address);
  const receipt = await registry.deploymentTransaction().wait();
  const address = await registry.getAddress();
  console.log(`ConsentRegistry deployed at ${address} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);

  const tx = await registry.setGateway(gatewayAddress, true);
  await tx.wait();
  console.log(`Gateway authorised: ${gatewayAddress}`);

  if (isLocal) {
    // Give the gateway some ETH so it can pay for logAccess transactions.
    const bal = await ethers.provider.getBalance(gatewayAddress);
    if (bal < ethers.parseEther("1")) {
      await (await deployer.sendTransaction({ to: gatewayAddress, value: ethers.parseEther("10") })).wait();
    }
  }

  const artifact = await hre.artifacts.readArtifact("ConsentRegistry");
  const out = {
    network: network.name,
    chainId: Number(network.config.chainId),
    address,
    deployBlock: receipt.blockNumber,
    gateway: gatewayAddress,
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
  };
  const dir = path.join(__dirname, "..", "..", "shared", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);

  if (network.name === "sepolia" && process.env.ETHERSCAN_API_KEY) {
    console.log("Waiting 5 confirmations before Etherscan verification...");
    await registry.deploymentTransaction().wait(5);
    try {
      await hre.run("verify:verify", { address, constructorArguments: [deployer.address] });
    } catch (e) {
      console.warn("Verification failed (you can retry with `npx hardhat verify`):", e.message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
