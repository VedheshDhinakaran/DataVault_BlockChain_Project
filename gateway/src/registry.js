import { ethers } from "ethers";

/** Thin wrapper around the ConsentRegistry contract for the gateway. */
export function createRegistry({ rpcUrl, provider, gatewayPrivateKey, deployment, pollMs = 4000 }) {
  provider ??= new ethers.JsonRpcProvider(rpcUrl, undefined, { pollingInterval: pollMs, cacheTimeout: -1 });
  const wallet = new ethers.Wallet(gatewayPrivateKey, provider);
  const read = new ethers.Contract(deployment.address, deployment.abi, provider);
  const write = read.connect(new ethers.NonceManager(wallet));

  return {
    provider,
    contract: read,
    gatewayAddress: wallet.address,
    deployBlock: deployment.deployBlock ?? 0,

    async getData(dataId) {
      try {
        const d = await read.getData(dataId);
        return {
          dataId: Number(dataId),
          owner: d.owner,
          category: Number(d.category),
          pointerVersion: Number(d.pointerVersion),
          createdAt: Number(d.createdAt),
          contentHash: d.contentHash,
          cid: d.cid,
        };
      } catch (e) {
        if (e?.revert?.name === "DataNotFound" || /DataNotFound/.test(e?.message)) return null;
        throw e;
      }
    },

    isAccessAllowed: (dataId, requester, purposeHash, action) =>
      read.isAccessAllowed(dataId, requester, purposeHash, action),

    /** True if `grantee` holds at least one active, unexpired consent on `dataId` (any purpose). */
    async hasEffectiveConsent(dataId, grantee) {
      const ids = await read.getConsentIdsByRequester(grantee);
      for (const id of ids) {
        const c = await read.getConsent(id);
        if (Number(c.dataId) === Number(dataId) && (await read.isConsentEffective(id))) return true;
      }
      return false;
    },

    async logAccess(dataId, requester, purposeHash, action) {
      const tx = await write.logAccess(dataId, requester, purposeHash, action);
      const r = await tx.wait();
      return r.hash;
    },

    async isAuthorisedGateway() {
      return read.isGateway(wallet.address);
    },
  };
}
