// Contract deployments are written by `npm run deploy:local` / `deploy:sepolia`
// into shared/deployments/<network>.json and picked up here at build time.
const files = import.meta.glob("../../../shared/deployments/*.json", { eager: true, import: "default" });

export const NETWORK = import.meta.env.VITE_NETWORK ?? "localhost";
export const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:4000";
export const deployment = Object.entries(files).find(([p]) => p.endsWith(`/${NETWORK}.json`))?.[1] ?? null;

export const CHAINS = {
  31337: {
    chainId: "0x7a69",
    chainName: "Hardhat Local",
    rpcUrls: ["http://127.0.0.1:8545"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  11155111: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    rpcUrls: ["https://rpc.sepolia.org"],
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
  },
};

export const explorerTx = (hash) =>
  deployment?.chainId === 11155111 ? `https://sepolia.etherscan.io/tx/${hash}` : null;
