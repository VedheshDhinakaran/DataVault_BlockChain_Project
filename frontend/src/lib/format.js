import { PURPOSES, purposeHash } from "@datavault/shared";

export const short = (a, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "");

const KNOWN = new Map(PURPOSES.map((p) => [purposeHash(p), p]));
export function rememberPurpose(p) {
  KNOWN.set(purposeHash(p), p.trim().toLowerCase());
  try {
    const saved = JSON.parse(localStorage.getItem("dv:purposes") || "[]");
    if (!saved.includes(p)) localStorage.setItem("dv:purposes", JSON.stringify([...saved, p]));
  } catch {}
}
try {
  for (const p of JSON.parse(localStorage.getItem("dv:purposes") || "[]")) KNOWN.set(purposeHash(p), p);
} catch {}
export const purposeName = (hash) => KNOWN.get(hash) ?? `custom (${short(hash)})`;

export const fmtTime = (s) => (s ? new Date(s * 1000).toLocaleString() : "never");
export const fmtExpiry = (s) => (Number(s) === 0 ? "no expiry" : new Date(Number(s) * 1000).toLocaleString());

export function errMsg(e) {
  if (e?.info?.error?.message) return e.info.error.message;
  if (e?.shortMessage) return e.shortMessage;
  if (e?.code === "ACTION_REJECTED") return "You rejected the request in MetaMask.";
  return e?.message ?? String(e);
}

export function downloadBytes(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
