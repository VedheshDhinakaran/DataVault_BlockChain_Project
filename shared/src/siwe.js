// Minimal Sign-In with Ethereum (EIP-4361) message builder and parser.
// Signature verification is done by the gateway with ethers.verifyMessage.

export function buildSiweMessage({ domain, address, statement, uri, chainId, nonce, issuedAt, expirationTime }) {
  const lines = [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    statement ?? "Sign in to DataVault.",
    "",
    `URI: ${uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt ?? new Date().toISOString()}`,
  ];
  if (expirationTime) lines.push(`Expiration Time: ${expirationTime}`);
  return lines.join("\n");
}

export function parseSiweMessage(message) {
  const lines = String(message).split("\n");
  const head = lines[0]?.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  if (!head) throw new Error("Not an EIP-4361 message");
  const fields = {};
  for (const line of lines.slice(2)) {
    const m = line.match(/^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time): (.+)$/);
    if (m) fields[m[1]] = m[2];
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(lines[1] || "")) throw new Error("Invalid address line");
  for (const k of ["URI", "Version", "Chain ID", "Nonce", "Issued At"]) {
    if (!fields[k]) throw new Error(`Missing field: ${k}`);
  }
  return {
    domain: head[1],
    address: lines[1],
    uri: fields.URI,
    version: fields.Version,
    chainId: Number(fields["Chain ID"]),
    nonce: fields.Nonce,
    issuedAt: fields["Issued At"],
    expirationTime: fields["Expiration Time"],
  };
}
