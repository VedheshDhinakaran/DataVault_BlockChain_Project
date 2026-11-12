import { ethers } from "ethers";
import { DataVaultClient } from "@datavault/shared";
import { CHAINS, GATEWAY_URL, deployment } from "./config.js";

export const hasMetaMask = () => typeof window !== "undefined" && !!window.ethereum;

/** Make sure MetaMask is on the chain the contract is deployed to. */
export async function ensureChain(chainId) {
  const hex = "0x" + Number(chainId).toString(16);
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current === hex) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code === 4902 && CHAINS[chainId]) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CHAINS[chainId]] });
    } else throw e;
  }
}

/** Connect MetaMask and return a DataVaultClient bound to the selected account. */
export async function connect() {
  if (!hasMetaMask()) throw new Error("MetaMask is not installed");
  await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensureChain(deployment.chainId);
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  return new DataVaultClient({
    gatewayUrl: GATEWAY_URL,
    signer,
    deployment,
    domain: window.location.host,
    uri: window.location.origin,
  });
}
