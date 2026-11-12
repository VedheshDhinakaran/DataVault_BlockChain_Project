import crypto from "node:crypto";
import { ethers } from "ethers";
import { parseSiweMessage } from "@datavault/shared";

const NONCE_TTL_MS = 10 * 60 * 1000;

/** Sign-In with Ethereum (EIP-4361): proves wallet ownership without passwords. */
export function createAuth({ db, chainId, siweDomains, sessionHours }) {
  return {
    issueNonce() {
      const nonce = crypto.randomBytes(16).toString("hex");
      db.addNonce(nonce);
      return nonce;
    },

    verify(message, signature) {
      const m = parseSiweMessage(message);
      if (siweDomains.length && !siweDomains.includes(m.domain)) throw new Error(`Domain ${m.domain} not allowed`);
      if (m.chainId !== Number(chainId)) throw new Error(`Wrong chain: expected ${chainId}, got ${m.chainId}`);
      if (m.expirationTime && Date.parse(m.expirationTime) < Date.now()) throw new Error("Sign-in message expired");
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== m.address.toLowerCase()) throw new Error("Signature does not match address");
      if (!db.takeNonce(m.nonce, NONCE_TTL_MS)) throw new Error("Unknown or expired nonce");

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + sessionHours * 3600 * 1000;
      db.addSession(token, recovered, expiresAt);
      return { token, address: ethers.getAddress(recovered), expiresAt };
    },

    middleware(req, res, next) {
      const h = req.headers.authorization || "";
      const token = h.startsWith("Bearer ") ? h.slice(7) : null;
      const s = token && db.getSession(token);
      if (!s) return res.status(401).json({ error: "Sign in with Ethereum first" });
      req.wallet = ethers.getAddress(s.address);
      req.sessionToken = token;
      next();
    },
  };
}
