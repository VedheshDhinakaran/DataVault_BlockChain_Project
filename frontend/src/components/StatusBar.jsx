import { useContext } from "react";
import { StatusContext } from "../lib/useTask.js";

export default function StatusBar() {
  const { status, setStatus } = useContext(StatusContext);
  if (!status) return null;
  const tone = {
    busy: "bg-stone-900 text-white",
    ok: "bg-emerald-700 text-white",
    error: "bg-red-700 text-white",
  }[status.kind];
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[90vw]">
      <div className={`${tone} rounded-lg shadow-lg px-4 py-2.5 text-sm flex items-center gap-3`}>
        {status.kind === "busy" && <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
        <span className="break-words">{status.text}</span>
        {status.kind !== "busy" && (
          <button className="opacity-70 hover:opacity-100" onClick={() => setStatus(null)} aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
