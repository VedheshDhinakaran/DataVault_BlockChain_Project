import { useEffect, useState } from "react";
import { useTask } from "../lib/useTask.js";
import { short, purposeName, fmtTime, fmtExpiry } from "../lib/format.js";
import { explorerTx } from "../lib/config.js";
import Badge from "./Badge.jsx";

const TONE = {
  DataRegistered: "brand",
  ConsentGranted: "green",
  ConsentModified: "amber",
  ConsentRevoked: "red",
  DataPointerUpdated: "stone",
  AccessLogged: "stone",
};

function describe(e) {
  switch (e.event) {
    case "DataRegistered":
      return `${short(e.owner)} registered ${e.category} data (cid ${short(e.cid, 6)})`;
    case "ConsentGranted":
      return `Granted ${short(e.requester)} ${e.actions.join(", ")} for ${purposeName(e.purposeHash)}, ${fmtExpiry(e.expiresAt)}`;
    case "ConsentModified":
      return `Consent #${e.consentId} changed to ${e.actions.join(", ")} for ${purposeName(e.purposeHash)}, ${fmtExpiry(e.expiresAt)} (v${e.version})`;
    case "ConsentRevoked":
      return `Consent #${e.consentId} for ${short(e.requester)} revoked`;
    case "DataPointerUpdated":
      return `Re-encrypted with a new key (key v${e.pointerVersion}, cid ${short(e.cid, 6)})`;
    case "AccessLogged":
      return `Gateway released data to ${short(e.requester)} for ${purposeName(e.purposeHash)} (${e.actions.join(", ")})`;
    default:
      return e.event;
  }
}

export default function AuditView({ client }) {
  const { run, busy } = useTask();
  const [ids, setIds] = useState([]);
  const [dataId, setDataId] = useState("");
  const [events, setEvents] = useState(null);
  const [gwLog, setGwLog] = useState(null);

  useEffect(() => {
    client.contract.dataCount().then((n) => {
      const all = Array.from({ length: Number(n) }, (_, i) => i + 1);
      setIds(all);
      if (all.length) setDataId(String(all[all.length - 1]));
    });
  }, [client]);

  async function load() {
    const id = Number(dataId);
    const ev = await run("Rebuilding history from on-chain events…", () => client.history(id));
    setEvents(ev ?? []);
    const d = await client.getData(id).catch(() => null);
    setGwLog(d && d.owner.toLowerCase() === client.address.toLowerCase() ? await client.api(`/data/${id}/log`).catch(() => null) : null);
  }

  useEffect(() => {
    if (dataId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataId]);

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <section className="lg:col-span-2 card p-5">
        <div className="flex items-end gap-3 mb-4">
          <div>
            <label className="label">Data item</label>
            <select className="input" value={dataId} onChange={(e) => setDataId(e.target.value)}>
              {ids.map((i) => (
                <option key={i} value={i}>
                  #{i}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-secondary" onClick={load} disabled={busy || !dataId}>
            Reload
          </button>
          <p className="text-xs text-stone-500 ml-auto max-w-xs">This timeline is rebuilt from contract events only. Anyone can verify it.</p>
        </div>
        {events?.length === 0 && <p className="text-sm text-stone-500">No events.</p>}
        <ol className="relative border-l border-stone-200 ml-2">
          {events?.map((e, i) => (
            <li key={i} className="ml-4 pb-4">
              <span className="absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full bg-white border-2 border-brand-500" />
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TONE[e.event]}>{e.event}</Badge>
                <span className="text-xs text-stone-400">
                  block {e.block} · {fmtTime(e.time)}
                </span>
              </div>
              <div className="text-sm mt-0.5">{describe(e)}</div>
              <div className="mono text-stone-400">
                {explorerTx(e.tx) ? (
                  <a className="underline" href={explorerTx(e.tx)} target="_blank" rel="noreferrer">
                    {short(e.tx, 8)}
                  </a>
                ) : (
                  short(e.tx, 8)
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="card p-5">
        <h2 className="font-display text-lg mb-1">Gateway log</h2>
        <p className="text-xs text-stone-500 mb-3">Off-chain enforcement actions for your own data: releases, denials, deleted keys.</p>
        {!gwLog && <p className="text-sm text-stone-500">Only the data owner can see the gateway log.</p>}
        <ul className="space-y-2 text-xs">
          {gwLog?.map((l) => (
            <li key={l.id} className="border-b border-stone-100 pb-1.5">
              <div className="flex gap-2">
                <Badge tone={l.kind === "denied" || l.kind === "key_deleted" ? "red" : l.kind === "released" ? "green" : "stone"}>{l.kind}</Badge>
                <span className="text-stone-400">{new Date(l.at).toLocaleTimeString()}</span>
              </div>
              {l.address && <div className="mono mt-0.5">{short(l.address)}</div>}
              {l.detail?.reason && <div className="text-stone-500">{l.detail.reason}</div>}
              {l.detail?.purpose && <div className="text-stone-500">purpose: {l.detail.purpose}</div>}
              {l.detail?.revokeToDeleteMs != null && <div className="text-stone-500">revoke → key deleted: {l.detail.revokeToDeleteMs} ms</div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
