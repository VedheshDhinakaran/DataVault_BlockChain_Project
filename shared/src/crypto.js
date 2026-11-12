// DataVault envelope encryption.
//
//   file  --AES-256-GCM(fileKey)-->  ciphertext  (stored in IPFS)
//   fileKey --ECIES(grantee pubkey)--> wrappedKey (stored by the gateway, one per grantee)
//
// ECIES construction: secp256k1 ECDH with an ephemeral key, HKDF-SHA256 to
// derive a 256-bit key, then AES-256-GCM. Implemented with the audited
// @noble libraries and WebCrypto so the same code runs in Node and in the
// browser with no polyfills.
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

const subtle = globalThis.crypto?.subtle;
if (!subtle) throw new Error("WebCrypto (crypto.subtle) is required: use Node 20+ or a secure (https/localhost) browser context");

const FILE_MAGIC = utf8ToBytes("DVF1"); // DataVault file format v1
const IV_LEN = 12;
const KEY_LEN = 32;
const ECIES_INFO = utf8ToBytes("DataVault-ECIES-v1");

// ---------------------------------------------------------------- helpers

export const toHex = (b) => "0x" + bytesToHex(b);
export const fromHex = (h) => hexToBytes(h.startsWith("0x") ? h.slice(2) : h);

async function aesGcmEncrypt(key, plaintext, aad) {
  const iv = randomBytes(IV_LEN);
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, k, plaintext)
  );
  return concatBytes(iv, ct);
}

async function aesGcmDecrypt(key, ivAndCiphertext, aad) {
  const iv = ivAndCiphertext.slice(0, IV_LEN);
  const ct = ivAndCiphertext.slice(IV_LEN);
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  try {
    return new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, k, ct)
    );
  } catch {
    throw new Error("Decryption failed: wrong key or tampered data");
  }
}

// ---------------------------------------------------------------- file layer (AES-256-GCM)

/** A fresh random 256-bit key for one file. */
export function generateFileKey() {
  return randomBytes(KEY_LEN);
}

/** Encrypt a file. Output layout: "DVF1" | iv(12) | ciphertext | tag(16). */
export async function encryptFile(plaintext, fileKey) {
  if (fileKey.length !== KEY_LEN) throw new Error("fileKey must be 32 bytes");
  return concatBytes(FILE_MAGIC, await aesGcmEncrypt(fileKey, plaintext, FILE_MAGIC));
}

/** Decrypt a file produced by encryptFile. Throws if the key is wrong. */
export async function decryptFile(blob, fileKey) {
  const magic = blob.slice(0, FILE_MAGIC.length);
  if (bytesToHex(magic) !== bytesToHex(FILE_MAGIC)) throw new Error("Not a DataVault encrypted file");
  return aesGcmDecrypt(fileKey, blob.slice(FILE_MAGIC.length), FILE_MAGIC);
}

/** sha256 of bytes as 0x-hex (the contentHash stored on-chain). */
export function sha256Hex(bytes) {
  return toHex(sha256(bytes));
}

// ---------------------------------------------------------------- key layer (ECIES on secp256k1)

/** Compressed public key (0x02.. / 0x03..) for a private key. */
export function getPublicKey(privateKey) {
  return toHex(secp256k1.getPublicKey(typeof privateKey === "string" ? fromHex(privateKey) : privateKey, true));
}

export function isValidPublicKey(pubHex) {
  try {
    secp256k1.ProjectivePoint.fromHex(fromHex(pubHex)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt (wrap) bytes for the holder of `recipientPublicKey`. Returns 0x-hex:
 *  ephemeralPub(33) | iv(12) | ciphertext | tag(16). */
export async function eciesEncrypt(recipientPublicKey, data) {
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, fromHex(recipientPublicKey), true).slice(1); // x-coord
  const key = hkdf(sha256, shared, ephPub, ECIES_INFO, KEY_LEN);
  return toHex(concatBytes(ephPub, await aesGcmEncrypt(key, data, ephPub)));
}

/** Decrypt (unwrap) bytes produced by eciesEncrypt. */
export async function eciesDecrypt(privateKey, wrappedHex) {
  const blob = fromHex(wrappedHex);
  const ephPub = blob.slice(0, 33);
  const priv = typeof privateKey === "string" ? fromHex(privateKey) : privateKey;
  const shared = secp256k1.getSharedSecret(priv, ephPub, true).slice(1);
  const key = hkdf(sha256, shared, ephPub, ECIES_INFO, KEY_LEN);
  return aesGcmDecrypt(key, blob.slice(33), ephPub);
}

export const wrapKey = (fileKey, recipientPublicKey) => eciesEncrypt(recipientPublicKey, fileKey);
export const unwrapKey = (wrappedHex, privateKey) => eciesDecrypt(privateKey, wrappedHex);

// ---------------------------------------------------------------- wallet-derived encryption key

/**
 * MetaMask does not expose the wallet's private key, so each user gets a
 * separate DataVault encryption key pair derived from a signature over a
 * fixed message. Wallet signatures are deterministic (RFC 6979), so the same
 * account always derives the same key, on any device, and the key never
 * leaves the browser.
 */
export function encryptionKeyMessage(address) {
  return [
    "DataVault encryption key",
    "",
    "Sign this message to unlock your DataVault encryption key.",
    "It does not send a transaction or cost gas.",
    "Only sign it on the DataVault app.",
    "",
    `Account: ${address.toLowerCase()}`,
    "Version: 1",
  ].join("\n");
}

/** Derive a valid secp256k1 private key from a signature (0x-hex). */
export function deriveEncryptionKey(signatureHex) {
  const sig = fromHex(signatureHex);
  for (let counter = 0; counter < 256; counter++) {
    const candidate = sha256(concatBytes(utf8ToBytes("DataVault-keygen-v1"), sig, new Uint8Array([counter])));
    if (secp256k1.utils.isValidPrivateKey(candidate)) {
      return { privateKey: toHex(candidate), publicKey: getPublicKey(candidate) };
    }
  }
  throw new Error("Could not derive key");
}
