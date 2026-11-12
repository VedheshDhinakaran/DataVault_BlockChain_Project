import { useCallback, useEffect, useMemo, useState } from "react";
import { ACTIONS, PURPOSES, actionsToList, unpackFile, purposeHash } from "@datavault/shared";
import { useTask } from "../lib/useTask.js";
import { short, purposeName, rememberPurpose, fmtExpiry, downloadBytes } from "../lib/format.js";
import Badge, { ConsentStatus } from "./Badge.jsx";

export default function RequesterView({ client }) {
  const { run, busy } = useTask();
  const [catalog, setCatalog] = useState([]);
  const [consents, setConsents] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [asking, setAsking] = useState(null);
  const [result, setResult] = useState(null);

  const refresh = useCallback(async () => {
    const [cat, cs, out] = await Promise.all([client.catalog(), client.consentsGrantedToMe(), client.api("/requests/outgoing").catch(() => [])]);
    setCatalog(cat.filter((d) => d.owner.toLowerCase() !== client.address.toLowerCase()).reverse());
    setConsents(cs.reverse());
    setOutgoing(out);
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function fetchData(c, purpose, action) {
    rememberPurpose(purpose);
    setResult(null);
    const t0 = performance.now();
    try {
      const r = await client.fetchData(c.dataId, purpose, action);
      const f = unpackFile(r.plaintext);
      const isText = /^text\/|json|xml|csv/.test(f.type) || f.name.match(/\.(txt|csv|json|md)$/i);
      setResult({ ok: true, dataId: c.dataId, file: f, preview: isText ? new TextDecoder().decode(f.bytes.slice(0, 4000)) : null, accessTx: r.accessTx, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setResult({ ok: false, dataId: c.dataId, status: e.status, error: e.message });
    }
  }

  return (
    <div className="grid lg:grid-cols-5 gap-5">
      <section className="lg:col-span-3 space-y-5">
        <div className="card p-5">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-display text-lg">Consents granted to me</h2>
            <button className="btn-secondary" onClick={refresh}>
              Refresh
            </button>
          </div>
          {consents.length === 0 && <p className="text-sm text-stone-500">No consents yet. Request access to a data item below.</p>}
          <ul className="space-y-3">
            {consents.map((c) => (
              <GrantedConsent key={c.consentId} c={c} busy={busy} onFetch={(p, a) => run("Gateway is checking isAccessAllowed on-chain…", () => fetchData(c, p, a))} />
            ))}
          </ul>
        </div>

        {result && (
          <div className={`card p-5 ${result.ok ? "border-emerald-300" : "border-red-300"}`}>
            {result.ok ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium">
                    Data #{result.dataId}: <span className="mono">{result.file.name}</span>{" "}
                    <span className="text-xs text-stone-500">({result.file.bytes.length} bytes, {result.ms} ms)</span>
                  </h3>
                  <button className="btn-primary" onClick={() => downloadBytes(result.file.bytes, result.file.name, result.file.type)}>
                    Save file
                  </button>
                </div>
                {result.accessTx && <p className="text-xs text-stone-500 mb-2">Access logged on-chain in <span className="mono">{short(result.accessTx, 8)}</span></p>}
                {result.preview && <pre className="bg-stone-50 rounded-lg p-3 text-xs overflow-auto max-h-64 whitespace-pre-wrap">{result.preview}</pre>}
              </>
            ) : (
              <>
                <h3 className="font-medium text-red-700">
                  Access denied {result.status ? `(HTTP ${result.status})` : ""}
                </h3>
                <p className="text-sm text-stone-600">{result.error}</p>
              </>
            )}
          </div>
        )}
      </section>

      <section className="lg:col-span-2 space-y-5">
        <div className="card p-5">
          <h2 className="font-display text-lg mb-1">Browse data</h2>
          <p className="text-xs text-stone-500 mb-3">Public on-chain metadata only: ID, owner and category.</p>
          {catalog.length === 0 && <p className="text-sm text-stone-500">No data from other owners yet.</p>}
          <ul className="divide-y divide-stone-100">
            {catalog.map((d) => (
              <li key={d.dataId} className="py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">#{d.dataId}</span>
                  <Badge tone="brand">{d.category}</Badge>
                  <span className="mono text-stone-500">{short(d.owner)}</span>
                  <button className="ml-auto text-brand-700 text-xs underline" onClick={() => setAsking(asking === d.dataId ? null : d.dataId)}>
                    Request access
                  </button>
                </div>
                {asking === d.dataId && (
                  <RequestForm
                    busy={busy}
                    onSubmit={(v) =>
                      run("Sending request to the owner…", () => client.api("/requests", { method: "POST", body: { dataId: d.dataId, ...v } }), "Request sent. The owner will see it in their dashboard.").then(() => {
                        rememberPurpose(v.purpose);
                        setAsking(null);
                        refresh();
                      })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="card p-5">
          <h2 className="font-display text-lg mb-3">My requests</h2>
          {outgoing.length === 0 && <p className="text-sm text-stone-500">None.</p>}
          <ul className="space-y-1.5 text-sm">
            {outgoing.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span>#{r.data_id}</span>
                <span className="text-stone-500">{r.purpose}</span>
                <span className="text-xs text-stone-400">{actionsToList(r.actions).join(", ")}</span>
                <span className="ml-auto">
                  <Badge tone={r.status === "approved" ? "green" : r.status === "declined" ? "red" : "amber"}>{r.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function GrantedConsent({ c, busy, onFetch }) {
  const known = purposeName(c.purposeHash);
  const [purpose, setPurpose] = useState(known.startsWith("custom") ? "" : known);
  const [action, setAction] = useState("read");
  const matches = useMemo(() => purpose && purposeHash(purpose) === c.purposeHash, [purpose, c.purposeHash]);
  return (
    <li className="border border-stone-200 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Data #{c.dataId}</span>
        <span className="text-stone-400">consent #{c.consentId} · v{c.version}</span>
        <ConsentStatus c={c} />
        <span className="ml-auto text-xs text-stone-500">{fmtExpiry(c.expiresAt)}</span>
      </div>
      <div className="text-xs text-stone-500 mt-1">
        Purpose <b>{known}</b> · allowed: {c.actionList.join(", ")}
      </div>
      <div className="flex flex-wrap gap-2 mt-2 items-end">
        <div className="flex-1 min-w-32">
          <label className="label">Stated purpose</label>
          <input className={`input ${purpose && !matches ? "border-amber-400" : ""}`} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. research" />
        </div>
        <div>
          <label className="label">Action</label>
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.keys(ACTIONS).map((a) => (
              <option key={a} value={a.toLowerCase()}>
                {a.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary" disabled={busy || !purpose} onClick={() => onFetch(purpose, action)}>
          Fetch & decrypt
        </button>
      </div>
      <p className="text-[11px] text-stone-400 mt-1">Try it after a revoke: the gateway re-checks the chain on every request and answers 403.</p>
    </li>
  );
}

function RequestForm({ onSubmit, busy }) {
  const [purpose, setPurpose] = useState("research");
  const [actions, setActions] = useState(ACTIONS.READ);
  const [note, setNote] = useState("");
  return (
    <form
      className="mt-2 grid gap-2 bg-stone-50 rounded-lg p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ purpose, actions, note });
      }}
    >
      <input className="input" list="dv-req-purposes" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Purpose" required />
      <datalist id="dv-req-purposes">
        {PURPOSES.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="flex gap-3 text-sm">
        {Object.entries(ACTIONS).map(([n, bit]) => (
          <label key={n} className="flex items-center gap-1">
            <input type="checkbox" className="accent-brand-600" checked={!!(actions & bit)} onChange={() => setActions((a) => a ^ bit)} />
            {n.toLowerCase()}
          </label>
        ))}
      </div>
      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the owner (optional)" maxLength={500} />
      <button className="btn-primary" disabled={busy || !actions}>
        Send request
      </button>
    </form>
  );
}
