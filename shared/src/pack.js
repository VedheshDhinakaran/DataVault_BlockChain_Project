// Optional file envelope: keeps the original file name and MIME type *inside*
// the encrypted payload, so they are never visible to IPFS, the gateway or the
// chain. Layout: "DVP1" | uint32 header length | header JSON | file bytes.
const MAGIC = [0x44, 0x56, 0x50, 0x31]; // "DVP1"

export function packFile(bytes, { name = "file", type = "application/octet-stream" } = {}) {
  const header = new TextEncoder().encode(JSON.stringify({ name, type, size: bytes.length }));
  const out = new Uint8Array(8 + header.length + bytes.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, header.length);
  out.set(header, 8);
  out.set(bytes, 8 + header.length);
  return out;
}

export function unpackFile(payload) {
  const isPacked = payload.length >= 8 && MAGIC.every((b, i) => payload[i] === b);
  if (!isPacked) return { name: "data.bin", type: "application/octet-stream", bytes: payload };
  const len = new DataView(payload.buffer, payload.byteOffset).getUint32(4);
  const meta = JSON.parse(new TextDecoder().decode(payload.slice(8, 8 + len)));
  return { ...meta, bytes: payload.slice(8 + len) };
}
