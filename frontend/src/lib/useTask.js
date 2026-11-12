import { createContext, useCallback, useContext, useState } from "react";
import { errMsg } from "./format.js";

export const StatusContext = createContext(null);

export function useStatusState() {
  const [status, setStatus] = useState(null); // { kind: 'busy'|'ok'|'error', text }
  return { status, setStatus };
}

/** Run an async step with a visible status line and readable errors. */
export function useTask() {
  const { setStatus } = useContext(StatusContext);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (label, fn, okText) => {
      setBusy(true);
      setStatus({ kind: "busy", text: label });
      try {
        const r = await fn();
        setStatus(okText ? { kind: "ok", text: typeof okText === "function" ? okText(r) : okText } : null);
        return r;
      } catch (e) {
        console.error(e);
        setStatus({ kind: "error", text: errMsg(e) });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [setStatus]
  );
  return { run, busy };
}
