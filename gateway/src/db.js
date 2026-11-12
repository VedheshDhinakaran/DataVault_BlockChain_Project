import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** The gateway's own store. It holds no plaintext and no file keys, only
 *  ECIES-wrapped keys, public keys, sessions and its own audit log. */
export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      address     TEXT PRIMARY KEY,
      public_key  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wrapped_keys (
      data_id     INTEGER NOT NULL,
      grantee     TEXT NOT NULL,
      cid         TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (data_id, grantee)
    );
    CREATE TABLE IF NOT EXISTS pointers (
      data_id     INTEGER PRIMARY KEY,
      cid         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nonces (
      nonce       TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      address     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      data_id     INTEGER NOT NULL,
      requester   TEXT NOT NULL,
      purpose     TEXT NOT NULL,
      actions     INTEGER NOT NULL,
      note        TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gateway_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      data_id     INTEGER,
      address     TEXT,
      detail      TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL
    );
  `);

  const now = () => Date.now();
  const lc = (a) => a.toLowerCase();

  return {
    raw: db,
    close: () => db.close(),

    // users / public keys
    setPublicKey: (address, publicKey) =>
      db.prepare(`INSERT INTO users(address, public_key, updated_at) VALUES(?,?,?)
                  ON CONFLICT(address) DO UPDATE SET public_key=excluded.public_key, updated_at=excluded.updated_at`)
        .run(lc(address), publicKey, now()),
    getPublicKey: (address) => db.prepare(`SELECT public_key FROM users WHERE address=?`).get(lc(address))?.public_key,

    // wrapped keys
    putWrappedKey: (dataId, grantee, cid, wrappedKey) =>
      db.prepare(`INSERT INTO wrapped_keys(data_id, grantee, cid, wrapped_key, created_at) VALUES(?,?,?,?,?)
                  ON CONFLICT(data_id, grantee) DO UPDATE SET cid=excluded.cid, wrapped_key=excluded.wrapped_key, created_at=excluded.created_at`)
        .run(Number(dataId), lc(grantee), cid, wrappedKey, now()),
    getWrappedKey: (dataId, grantee) =>
      db.prepare(`SELECT * FROM wrapped_keys WHERE data_id=? AND grantee=?`).get(Number(dataId), lc(grantee)),
    listWrappedKeys: (dataId) =>
      db.prepare(`SELECT data_id, grantee, cid, created_at FROM wrapped_keys WHERE data_id=?`).all(Number(dataId)),
    allWrappedKeys: () => db.prepare(`SELECT data_id, grantee, cid FROM wrapped_keys`).all(),
    deleteWrappedKey: (dataId, grantee) =>
      db.prepare(`DELETE FROM wrapped_keys WHERE data_id=? AND grantee=?`).run(Number(dataId), lc(grantee)).changes,
    deleteStaleKeys: (dataId, currentCid) =>
      db.prepare(`DELETE FROM wrapped_keys WHERE data_id=? AND cid<>?`).run(Number(dataId), currentCid).changes,

    // pointers (last seen CID per data item, used to unpin old ciphertext after rotation)
    getPointer: (dataId) => db.prepare(`SELECT cid FROM pointers WHERE data_id=?`).get(Number(dataId))?.cid,
    setPointer: (dataId, cid) =>
      db.prepare(`INSERT INTO pointers(data_id, cid) VALUES(?,?) ON CONFLICT(data_id) DO UPDATE SET cid=excluded.cid`)
        .run(Number(dataId), cid),

    // SIWE nonces and sessions
    addNonce: (nonce) => db.prepare(`INSERT INTO nonces(nonce, created_at) VALUES(?,?)`).run(nonce, now()),
    takeNonce: (nonce, maxAgeMs) => {
      const row = db.prepare(`SELECT created_at FROM nonces WHERE nonce=?`).get(nonce);
      db.prepare(`DELETE FROM nonces WHERE nonce=? OR created_at < ?`).run(nonce, now() - maxAgeMs);
      return !!row && now() - row.created_at <= maxAgeMs;
    },
    addSession: (token, address, expiresAt) =>
      db.prepare(`INSERT INTO sessions(token, address, expires_at) VALUES(?,?,?)`).run(token, lc(address), expiresAt),
    getSession: (token) => db.prepare(`SELECT * FROM sessions WHERE token=? AND expires_at > ?`).get(token, now()),
    deleteSession: (token) => db.prepare(`DELETE FROM sessions WHERE token=?`).run(token),

    // access requests (off-chain "please grant me consent" messages)
    addRequest: ({ dataId, requester, purpose, actions, note }) =>
      db.prepare(`INSERT INTO requests(data_id, requester, purpose, actions, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(Number(dataId), lc(requester), purpose, actions, note ?? null, now(), now()).lastInsertRowid,
    getRequest: (id) => db.prepare(`SELECT * FROM requests WHERE id=?`).get(Number(id)),
    requestsForData: (dataIds) =>
      dataIds.length
        ? db.prepare(`SELECT * FROM requests WHERE data_id IN (${dataIds.map(() => "?").join(",")}) ORDER BY id DESC`)
            .all(...dataIds.map(Number))
        : [],
    requestsByRequester: (address) =>
      db.prepare(`SELECT * FROM requests WHERE requester=? ORDER BY id DESC`).all(lc(address)),
    setRequestStatus: (id, status) =>
      db.prepare(`UPDATE requests SET status=?, updated_at=? WHERE id=?`).run(status, now(), Number(id)),

    // gateway audit log
    log: (kind, { dataId, address, detail } = {}) =>
      db.prepare(`INSERT INTO gateway_log(at, kind, data_id, address, detail) VALUES(?,?,?,?,?)`)
        .run(now(), kind, dataId == null ? null : Number(dataId), address ? lc(address) : null,
             detail == null ? null : JSON.stringify(detail)),
    logsForData: (dataId, limit = 200) =>
      db.prepare(`SELECT * FROM gateway_log WHERE data_id=? ORDER BY id DESC LIMIT ?`).all(Number(dataId), limit),

    // meta
    getMeta: (key) => db.prepare(`SELECT value FROM meta WHERE key=?`).get(key)?.value,
    setMeta: (key, value) =>
      db.prepare(`INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .run(key, String(value)),
  };
}
