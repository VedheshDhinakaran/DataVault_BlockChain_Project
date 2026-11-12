import { useCallback, useEffect, useState } from "react";
import { CATEGORIES, packFile, unpackFile, actionsToList } from "@datavault/shared";
import { useTask } from "../lib/useTask.js";
import { short, purposeName, rememberPurpose, fmtExpiry, downloadBytes } from "../lib/format.js";
import ConsentForm from "./ConsentForm.jsx";
import Badge, { ConsentStatus } from "./Badge.jsx";

export default function OwnerView({ client }) {
  const { run, busy } = useTask();
  const [items, setItems] = useState(null);
  const [requests, setRequests] = useState([]);
  const [file, setFile] = useState(null);
  const [category, setCategory] = useState("Health");
  const [prefill, setPrefill] = useState(null);

  const refresh = useCallback(async () => {
    const [mine, incoming] = await Promise.all([client.myData(), client.api("/requests/incoming").catch(() => [])]);
    setItems(mine.reverse());
    setRequests(incoming);
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    const r = await run(
      "Encrypting in your browser, pinning ciphertext to IPFS, then confirm registerData in MetaMask…",
      async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return client.uploadAndRegister(packFile(bytes, { name: file.name, type: file.type || "application/octet-stream" }), category);
      },
      (r) => `Registered as data #${r.dataId} (gas ${r.gasUsed})`
    );
    if (r) {
      setFile(null);
      e.target.reset();
      refresh();
    }
  }

  const pending = requests.filter((r) => r.status === "pending");

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="space-y-5">
        <section className="card p-5">
          <h2 className="font-display text-lg mb-1">Upload data</h2>
          <p className="text-xs text-stone-500 mb-4">
            The file is encrypted with a fresh AES-256-GCM key before upload. Its name and type are stored inside the
            ciphertext.
          </p>
          <form onSubmit={upload} className="space-y-3">
            <input type="file" className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-stone-300 file:bg-white file:px-3 file:py-1.5 file:text-sm hover:file:bg-stone-100" onChange={(e) => setFile(e.target.files[0])} required />
            <div>
              <label className="label">Category</label>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <button className="btn-primary w-full" disabled={busy || !file}>
              Encrypt and register
            </button>
          </form>
        </section>

        <section className="card p-5">
          <h2 className="font-display text-lg mb-3">
            Access requests {pending.length > 0 && <Badge tone="brand">{pending.length} pending</Badge>}
          </h2>
          {requests.length === 0 && <p className="text-sm text-stone-500">No requests yet.</p>}
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="border border-stone-200 rounded-lg p-3 text-sm">
                <div className="flex justify-between items-start gap-2">
                  <div>
                    <div>
                      <span className="mono">{short(r.requester)}</span> wants data #{r.data_id}
                    </div>
                    <div className="text-xs text-stone-500">
                      for <b>{r.purpose}</b> · {actionsToList(r.actions).join(", ")}
                    </div>
                    {r.note && <div className="text-xs text-stone-600 mt-1 italic">“{r.note}”</div>}
                  </div>
                  <Badge tone={r.status === "approved" ? "green" : r.status === "declined" ? "red" : "amber"}>{r.status}</Badge>
                </div>
                {r.status === "pending" && (
                  <div className="flex gap-2 mt-2">
                    <button
                      className="btn-primary"
                      onClick={() => setPrefill({ dataId: r.data_id, requestId: r.id, requester: r.requester, purpose: r.purpose, actions: r.actions })}
                    >
                      Review & grant
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => run("Declining…", () => client.api(`/requests/${r.id}`, { method: "PATCH", body: { status: "declined" } })).then(refresh)}
                    >
                      Decline
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="lg:col-span-2 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg">My data items</h2>
          <button className="btn-secondary" onClick={refresh}>
            Refresh
          </button>
        </div>
        {items === null && <p className="text-sm text-stone-500">Loading from the chain…</p>}
        {items?.length === 0 && <p className="text-sm text-stone-500 card p-6">You have not registered any data yet.</p>}
        {items?.map((d) => (
          <DataItem
            key={d.dataId}
            client={client}
            item={d}
            onChanged={refresh}
            prefill={prefill?.dataId === d.dataId ? prefill : null}
            clearPrefill={() => setPrefill(null)}
          />
        ))}
      </section>
    </div>
  );
}

function DataItem({ client, item, onChanged, prefill, clearPrefill }) {
  const { run, busy } = useTask();
  const [consents, setConsents] = useState([]);
  const [keys, setKeys] = useState([]);
  const [granting, setGranting] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    const [cs, ks] = await Promise.all([client.consentsForData(item.dataId), client.api(`/data/${item.dataId}/keys`).catch(() => ({ keys: [] }))]);
    setConsents(cs.reverse());
    setKeys(ks.keys);
  }, [client, item.dataId]);

  useEffect(() => {
    load();
  }, [load, item.pointerVersion]);

  useEffect(() => {
    if (prefill) setGranting(true);
  }, [prefill]);

  const hasKey = (addr) => keys.some((k) => k.grantee.toLowerCase() === addr.toLowerCase() && k.current);
  const after = async () => {
    await load();
    onChanged();
  };

  async function grant(v) {
    rememberPurpose(v.purpose);
    const r = await run(
      "Confirm grantConsent in MetaMask, then the file key is re-wrapped for the requester…",
      () => client.grant(item.dataId, v.requester, v.purpose, v.actions, v.expiresAt),
      (r) => `Consent #${r.consentId} granted${r.keyShared ? " and key shared" : ". The requester has no encryption key yet; share it once they sign in."}`
    );
    if (r) {
      if (prefill?.requestId) await client.api(`/requests/${prefill.requestId}`, { method: "PATCH", body: { status: "approved" } }).catch(() => {});
      setGranting(false);
      clearPrefill();
      after();
    }
  }

  async function modify(c, v) {
    rememberPurpose(v.purpose);
    const r = await run("Confirm modifyConsent in MetaMask…", () => client.modify(c.consentId, v.purpose, v.actions, v.expiresAt), "Consent updated (version +1)");
    if (r) {
      setEditing(null);
      after();
    }
  }

  async function download() {
    const r = await run("Fetching ciphertext through the gateway and decrypting…", () => client.fetchData(item.dataId));
    if (r) {
      const f = unpackFile(r.plaintext);
      downloadBytes(f.bytes, f.name, f.type);
    }
  }

  return (
    <article className="card">
      <header className="p-4 flex flex-wrap items-center gap-3 border-b border-stone-100">
        <div className="font-display text-lg">#{item.dataId}</div>
        <Badge tone="brand">{item.category}</Badge>
        <span className="mono text-stone-500" title={item.cid}>
          cid {short(item.cid, 6)}
        </span>
        <span className="text-xs text-stone-400">key v{item.pointerVersion}</span>
        <div className="ml-auto flex gap-2">
          <button className="btn-secondary" onClick={download} disabled={busy}>
            Download
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            title="Re-encrypt with a new key and re-share it only with active grantees"
            onClick={() => run("Re-encrypting with a new key; confirm updateDataPointer in MetaMask…", () => client.rotate(item.dataId), (r) => `Rotated. New key shared with ${r.rewrappedFor} grantee(s).`).then(after)}
          >
            Rotate key
          </button>
          <button className="btn-primary" onClick={() => setGranting((g) => !g)}>
            Grant access
          </button>
        </div>
      </header>

      {granting && (
        <div className="p-4 bg-stone-50 border-b border-stone-100">
          <ConsentForm
            key={prefill?.requestId ?? "new"}
            withRequester
            initial={prefill ?? {}}
            submitLabel="Grant consent"
            busy={busy}
            onSubmit={grant}
            onCancel={() => {
              setGranting(false);
              clearPrefill();
            }}
          />
        </div>
      )}

      <div className="p-4">
        {consents.length === 0 ? (
          <p className="text-sm text-stone-500">No consents granted. Nobody but you can read this data.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-stone-500 border-b border-stone-100">
                  <th className="py-1.5 pr-2">#</th>
                  <th className="pr-2">Requester</th>
                  <th className="pr-2">Purpose</th>
                  <th className="pr-2">Actions</th>
                  <th className="pr-2">Expires</th>
                  <th className="pr-2">Ver.</th>
                  <th className="pr-2">Status</th>
                  <th className="pr-2">Key</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {consents.map((c) => (
                  <ConsentRow
                    key={c.consentId}
                    c={c}
                    keyHeld={hasKey(c.requester)}
                    busy={busy}
                    editing={editing === c.consentId}
                    onEdit={() => setEditing(editing === c.consentId ? null : c.consentId)}
                    onModify={(v) => modify(c, v)}
                    onRevoke={() => run("Confirm revokeConsent in MetaMask…", () => client.revoke(c.consentId), "Revoked. The gateway now returns 403 and deletes the wrapped key.").then(after)}
                    onRevokeRotate={() =>
                      run("Revoking, then re-encrypting with a new key (two MetaMask confirmations)…", () => client.revokeAndRotate(c.consentId), (r) => `Revoked and rotated. New key shared with ${r.rotated.rewrappedFor} remaining grantee(s).`).then(after)
                    }
                    onShareKey={() =>
                      run("Wrapping the file key for this requester…", () => client.shareKey(item.dataId, c.requester), (ok) => (ok ? "Key shared." : "The requester has not unlocked a DataVault key yet.")).then(after)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </article>
  );
}

function ConsentRow({ c, keyHeld, busy, editing, onEdit, onModify, onRevoke, onRevokeRotate, onShareKey }) {
  const active = c.status === "Active";
  return (
    <>
      <tr className="border-b border-stone-50 align-middle">
        <td className="py-2 pr-2 text-stone-400">{c.consentId}</td>
        <td className="pr-2 mono" title={c.requester}>
          {short(c.requester)}
        </td>
        <td className="pr-2">{purposeName(c.purposeHash)}</td>
        <td className="pr-2 text-xs">{c.actionList.join(", ")}</td>
        <td className="pr-2 text-xs">{fmtExpiry(c.expiresAt)}</td>
        <td className="pr-2 text-xs">v{c.version}</td>
        <td className="pr-2">
          <ConsentStatus c={c} />
        </td>
        <td className="pr-2 text-xs">{keyHeld ? <Badge tone="green">held</Badge> : active && c.effective ? <button className="text-brand-700 underline" onClick={onShareKey} disabled={busy}>share</button> : <span className="text-stone-400">none</span>}</td>
        <td className="text-right whitespace-nowrap">
          {active && (
            <div className="flex gap-1 justify-end">
              <button className="btn-secondary px-2! py-1! text-xs" onClick={onEdit} disabled={busy}>
                Modify
              </button>
              <button className="btn-danger px-2! py-1! text-xs" onClick={onRevoke} disabled={busy}>
                Revoke
              </button>
              <button className="btn-danger px-2! py-1! text-xs" onClick={onRevokeRotate} disabled={busy} title="Revoke, then re-encrypt the file with a new key">
                Revoke + rotate
              </button>
            </div>
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={9} className="bg-stone-50 p-3">
            <ConsentForm
              initial={{ purpose: purposeName(c.purposeHash).startsWith("custom") ? "" : purposeName(c.purposeHash), actions: c.actions, expiresAt: c.expiresAt }}
              submitLabel="Save changes"
              busy={busy}
              onSubmit={onModify}
              onCancel={onEdit}
            />
          </td>
        </tr>
      )}
    </>
  );
}
