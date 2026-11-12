import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/** Action bitmask, mirrors ConsentRegistry constants. */
export const ACTIONS = { READ: 1, SHARE: 2, PROCESS: 4 };
export const ALL_ACTIONS = 7;

/** Data categories, mirrors the ConsentRegistry.Category enum order. */
export const CATEGORIES = ["Health", "Finance", "Education", "Location", "Other"];

/** Consent status, mirrors ConsentRegistry.Status. */
export const STATUS = ["None", "Active", "Revoked"];

/** Common purposes offered in the UI. Any string can be used. */
export const PURPOSES = ["research", "treatment", "analytics", "marketing", "credit-check", "verification"];

/** Purposes are normalised (trim + lowercase) and stored on-chain as keccak256. */
export function normalisePurpose(purpose) {
  return String(purpose).trim().toLowerCase();
}

export function purposeHash(purpose) {
  return "0x" + bytesToHex(keccak_256(utf8ToBytes(normalisePurpose(purpose))));
}

export function actionsToList(mask) {
  return Object.entries(ACTIONS)
    .filter(([, bit]) => (Number(mask) & bit) === bit)
    .map(([name]) => name.toLowerCase());
}
