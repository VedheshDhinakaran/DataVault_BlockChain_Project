import { useEffect, useState } from "react";
import { deployment, NETWORK, GATEWAY_URL } from "./lib/config.js";
import { connect, hasMetaMask } from "./lib/wallet.js";
import { StatusContext, useStatusState } from "./lib/useTask.js";
import { errMsg, short } from "./lib/format.js";
import OwnerView from "./components/OwnerView.jsx";
import RequesterView from "./components/RequesterView.jsx";
import AuditView from "./components/AuditView.jsx";
import StatusBar from "./components/StatusBar.jsx";

const TABS = [
  { id: "owner", label: "My data", hint: "Data owner" },
  { id: "requester", label: "Request & access", hint: "Requester" },
  { id: "audit", label: "Audit trail", hint: "Anyone" },
];

export default function App() {
  const statusState = useStatusState();
  const [client, setClient] = useState(null);
  const [step, setStep] = useState("idle"); // idle | connecting | ready
  const [tab, setTab] = useState("owner");
  const [error, setError] = useState(null);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch(`${GATEWAY_URL}/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth(false));
  }, []);

  useEffect(() => {
    if (!hasMetaMask()) return;
    const reset = () => {
      setClient(null);
      setStep("idle");
    };
    window.ethereum.on?.("accountsChanged", reset);
    window.ethereum.on?.("chainChanged", reset);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", reset);
      window.ethereum.removeListener?.("chainChanged", reset);
    };
  }, []);

  async function start() {
    setError(null);
    setStep("connecting");
    try {
      const c = await connect();
      await c.signIn(); // signature 1: Sign-In with Ethereum
      await c.unlockEncryptionKey(); // signature 2: derive the DataVault encryption key
      setClient(c);
      setStep("ready");
    } catch (e) {
      setError(errMsg(e));
      setStep("idle");
    }
  }

  if (!deployment) {
    return (
      <Shell>
        <div className="card p-6 max-w-xl mx-auto mt-10">
          <h2 className="font-display text-xl mb-2">Contract not deployed yet</h2>
          <p className="text-sm text-stone-600">
            No deployment found for network <b>{NETWORK}</b>. In the project root run{" "}
            <code className="mono bg-stone-100 px-1 rounded">npm run chain</code> and then{" "}
            <code className="mono bg-stone-100 px-1 rounded">npm run deploy:local</code>, then reload this page.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <StatusContext.Provider value={statusState}>
      <Shell
        right={
          client ? (
            <div className="text-right">
              <div className="mono text-stone-700">{short(client.address, 6)}</div>
              <div className="text-[11px] text-emerald-700">signed in · key unlocked</div>
            </div>
          ) : null
        }
      >
        {health === false && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            The Access Gateway at {GATEWAY_URL} is not reachable. Start it with <code className="mono">npm run gateway</code>.
          </div>
        )}

        {step !== "ready" ? (
          <Welcome onStart={start} step={step} error={error} health={health} />
        ) : (
          <>
            <nav className="flex gap-1 mb-5 border-b border-stone-200">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 text-sm -mb-px border-b-2 ${
                    tab === t.id ? "border-brand-600 text-brand-700 font-medium" : "border-transparent text-stone-500 hover:text-stone-800"
                  }`}
                >
                  {t.label} <span className="text-[11px] text-stone-400 ml-1 hidden sm:inline">{t.hint}</span>
                </button>
              ))}
            </nav>
            {tab === "owner" && <OwnerView client={client} />}
            {tab === "requester" && <RequesterView client={client} />}
            {tab === "audit" && <AuditView client={client} />}
          </>
        )}
        <StatusBar />
      </Shell>
    </StatusContext.Provider>
  );
}

function Shell({ children, right }) {
  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" className="w-8 h-8" />
            <div>
              <div className="font-display text-lg leading-tight">DataVault</div>
              <div className="text-[11px] text-stone-500 leading-tight">Blockchain consent management for personal data</div>
            </div>
          </div>
          {right}
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6 pb-24">{children}</main>
    </div>
  );
}

function Welcome({ onStart, step, error, health }) {
  return (
    <div className="max-w-2xl mx-auto mt-6">
      <div className="card p-8">
        <h1 className="font-display text-2xl mb-2">Your data, your consent.</h1>
        <p className="text-stone-600 text-sm mb-6">
          Grant, modify and revoke access to your personal data with smart contracts. Files are encrypted in your browser
          with AES-256-GCM before they leave your device; only hashes and permissions go on-chain, and every request is
          checked against the chain by the Access Gateway.
        </p>
        <ol className="text-sm text-stone-600 space-y-1.5 mb-6 list-decimal list-inside">
          <li>Connect MetaMask (network: {deployment.network}, chain {deployment.chainId})</li>
          <li>Sign in with Ethereum: a free signature that proves you own the account</li>
          <li>Unlock your encryption key: a second free signature from which your key is derived in the browser</li>
        </ol>
        {hasMetaMask() ? (
          <button className="btn-primary px-5 py-2" onClick={onStart} disabled={step === "connecting" || health === false}>
            {step === "connecting" ? "Check MetaMask…" : "Connect MetaMask"}
          </button>
        ) : (
          <a className="btn-primary px-5 py-2" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            Install MetaMask
          </a>
        )}
        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}
      </div>
      <div className="grid sm:grid-cols-3 gap-3 mt-4 text-sm">
        {[
          ["No personal data on-chain", "The chain holds only IDs, hashes, addresses and permission flags."],
          ["One enforcement point", "Every data request goes through the gateway, which asks the contract first."],
          ["Revocation reaches the data", "Revoked keys are deleted at once; revoke-and-rotate re-encrypts the file."],
        ].map(([t, d]) => (
          <div key={t} className="card p-4">
            <div className="font-medium text-stone-800 mb-1">{t}</div>
            <div className="text-stone-500 text-xs">{d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
