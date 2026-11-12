export default function Badge({ tone = "stone", children }) {
  const tones = {
    stone: "bg-stone-100 text-stone-700",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    red: "bg-red-50 text-red-700 ring-1 ring-red-200",
    amber: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
    brand: "bg-brand-50 text-brand-700 ring-1 ring-brand-100",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function ConsentStatus({ c }) {
  if (c.status === "Revoked") return <Badge tone="red">revoked</Badge>;
  if (!c.effective) return <Badge tone="amber">expired</Badge>;
  return <Badge tone="green">active</Badge>;
}
