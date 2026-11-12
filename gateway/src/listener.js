// Off-chain enforcement of revocation (deck slide 15, "Listen and rotate").
// Polls the chain for ConsentRevoked / DataPointerUpdated / DataRegistered
// logs (eth_getLogs polling is more robust on public RPCs than filters) and:
//   * ConsentRevoked      -> deletes the requester's wrapped key at once
//   * DataPointerUpdated  -> drops keys wrapped for the old ciphertext and unpins it
//   * periodic sweep      -> deletes wrapped keys whose consent has expired
// The per-request isAccessAllowed check in app.js is the hard guarantee; this
// listener makes sure the gateway does not even keep keys it no longer needs.

const MAX_RANGE = 2000;

export function createListener({ registry, db, storage, pollMs = 1000, sweepMs = 60000, logger = console }) {
  const iface = registry.contract.interface;
  const address = registry.contract.target;
  let timer = null;
  let sweepTimer = null;
  let running = false;
  const stats = { revocationsHandled: 0, keysDeleted: 0, rotations: 0, lastRevokeToDeleteMs: null };

  async function onRevoked({ consentId, dataId, requester }, log) {
    stats.revocationsHandled++;
    // The requester might still hold a different-purpose consent on the same
    // data; only drop the key if no effective consent remains.
    if (await registry.hasEffectiveConsent(dataId, requester)) {
      db.log("revoke_kept_key", { dataId, address: requester, detail: { consentId: String(consentId), reason: "other consent still active" } });
      return;
    }
    const deleted = db.deleteWrappedKey(dataId, requester);
    const block = await registry.provider.getBlock(log.blockNumber);
    const latency = block ? Date.now() - Number(block.timestamp) * 1000 : null;
    stats.keysDeleted += deleted;
    stats.lastRevokeToDeleteMs = latency;
    db.log("key_deleted", {
      dataId,
      address: requester,
      detail: { consentId: String(consentId), reason: "revoked", tx: log.transactionHash, deleted, revokeToDeleteMs: latency },
    });
    logger.info?.(`[listener] ConsentRevoked #${consentId} data ${dataId} -> deleted ${deleted} wrapped key(s) for ${requester}`);
  }

  async function onPointerUpdated({ dataId, cid }, log) {
    stats.rotations++;
    const oldCid = db.getPointer(dataId);
    const dropped = db.deleteStaleKeys(dataId, cid);
    db.setPointer(dataId, cid);
    if (oldCid && oldCid !== cid) await storage.unpin(oldCid).catch(() => {});
    db.log("rotated", { dataId, detail: { oldCid, newCid: cid, droppedKeys: dropped, tx: log.transactionHash } });
    logger.info?.(`[listener] DataPointerUpdated data ${dataId}: ${oldCid} -> ${cid}, dropped ${dropped} stale key(s)`);
  }

  async function handle(log) {
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      return;
    }
    if (!parsed) return;
    const a = parsed.args;
    switch (parsed.name) {
      case "DataRegistered":
        db.setPointer(a.dataId, a.cid);
        break;
      case "ConsentRevoked":
        await onRevoked(a, log);
        break;
      case "DataPointerUpdated":
        await onPointerUpdated(a, log);
        break;
    }
  }

  /** Process every new block up to the chain head. Safe to call concurrently. */
  async function processNow() {
    if (running) return;
    running = true;
    try {
      let last = Number(db.getMeta(`lastBlock:${address}`) ?? registry.deployBlock - 1);
      const head = await registry.provider.getBlockNumber();
      while (last < head) {
        const from = last + 1;
        const to = Math.min(head, from + MAX_RANGE - 1);
        const logs = await registry.provider.getLogs({ address, fromBlock: from, toBlock: to });
        for (const log of logs) await handle(log);
        last = to;
        db.setMeta(`lastBlock:${address}`, last);
      }
    } finally {
      running = false;
    }
  }

  /** Delete wrapped keys of grantees whose consent expired (expiry emits no event). */
  async function sweepExpired() {
    const owners = new Map();
    for (const row of db.allWrappedKeys()) {
      if (!owners.has(row.data_id)) owners.set(row.data_id, (await registry.getData(row.data_id))?.owner?.toLowerCase());
      if (row.grantee === owners.get(row.data_id)) continue;
      if (!(await registry.hasEffectiveConsent(row.data_id, row.grantee))) {
        db.deleteWrappedKey(row.data_id, row.grantee);
        stats.keysDeleted++;
        db.log("key_deleted", { dataId: row.data_id, address: row.grantee, detail: { reason: "expired or no consent" } });
      }
    }
  }

  const loop = async () => {
    try {
      await processNow();
    } catch (e) {
      logger.error?.("[listener] poll error:", e.shortMessage ?? e.message);
    }
    timer = setTimeout(loop, pollMs);
  };

  return {
    stats,
    processNow,
    sweepExpired,
    start() {
      loop();
      sweepTimer = setInterval(() => sweepExpired().catch((e) => logger.error?.("[listener] sweep error:", e.message)), sweepMs);
    },
    stop() {
      clearTimeout(timer);
      clearInterval(sweepTimer);
    },
  };
}
