import { useState } from "react";
import { ACTIONS, PURPOSES } from "@datavault/shared";

const toLocalInput = (s) => {
  if (!s) return "";
  const d = new Date(s * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/** Purpose + actions + expiry, used for grant and modify. */
export default function ConsentForm({ initial = {}, withRequester = false, submitLabel, onSubmit, onCancel, busy }) {
  const [requester, setRequester] = useState(initial.requester ?? "");
  const [purpose, setPurpose] = useState(initial.purpose ?? "research");
  const [actions, setActions] = useState(initial.actions ?? ACTIONS.READ);
  const [expiry, setExpiry] = useState(toLocalInput(initial.expiresAt));

  const toggle = (bit) => setActions((a) => (a & bit ? a & ~bit : a | bit));
  const submit = (e) => {
    e.preventDefault();
    const expiresAt = expiry ? Math.floor(new Date(expiry).getTime() / 1000) : 0;
    onSubmit({ requester: requester.trim(), purpose: purpose.trim(), actions, expiresAt });
  };

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      {withRequester && (
        <div className="sm:col-span-2">
          <label className="label">Requester address</label>
          <input className="input mono" placeholder="0x…" value={requester} onChange={(e) => setRequester(e.target.value)} required pattern="^0x[0-9a-fA-F]{40}$" />
        </div>
      )}
      <div>
        <label className="label">Purpose</label>
        <input className="input" list="dv-purposes" value={purpose} onChange={(e) => setPurpose(e.target.value)} required />
        <datalist id="dv-purposes">
          {PURPOSES.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <div>
        <label className="label">Expires (leave empty for no expiry)</label>
        <input className="input" type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <label className="label">Allowed actions</label>
        <div className="flex gap-4 text-sm">
          {Object.entries(ACTIONS).map(([name, bit]) => (
            <label key={name} className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!(actions & bit)} onChange={() => toggle(bit)} className="accent-brand-600" />
              {name.toLowerCase()}
            </label>
          ))}
        </div>
      </div>
      <div className="sm:col-span-2 flex gap-2">
        <button className="btn-primary" disabled={busy || !actions}>{submitLabel}</button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
