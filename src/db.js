// SQLite persistence (node:sqlite, no ORM). Wei amounts are stored as TEXT and
// handled as BigInt in JS — SQLite INTEGER is int64 and overflows past ~9.2 ETH.
import { DatabaseSync } from 'node:sqlite';

let db;

export function init(path = process.env.DB_PATH || './keeper.db') {
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY,
      group_key TEXT NOT NULL UNIQUE,
      threshold_pct REAL NOT NULL,
      registrant_address TEXT NOT NULL,
      network_class TEXT NOT NULL CHECK (network_class IN ('mainnet','testnet')),
      balance_wei TEXT NOT NULL DEFAULT '0',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','underfunded','paused')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES groups(id),
      chain_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      UNIQUE (chain_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY,
      tx_hash TEXT NOT NULL UNIQUE,
      chain_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      amount_wei TEXT NOT NULL,
      group_id INTEGER NOT NULL REFERENCES groups(id),
      credited_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS syncs (
      id INTEGER PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id),
      plan_json TEXT NOT NULL,
      relayr_bundle_uuid TEXT,
      quoted_cost_wei TEXT NOT NULL,
      final_cost_wei TEXT,
      state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','success','failed')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER
    );
  `);
  return db;
}

export function createGroup({ groupKey, thresholdPct, registrant, networkClass, members }) {
  const tx = db.prepare('INSERT INTO groups (group_key, threshold_pct, registrant_address, network_class) VALUES (?, ?, ?, ?)');
  const { lastInsertRowid: id } = tx.run(groupKey, thresholdPct, registrant.toLowerCase(), networkClass);
  replaceMembers(Number(id), members);
  return Number(id);
}

export function replaceMembers(groupId, members) {
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
  const ins = db.prepare('INSERT INTO group_members (group_id, chain_id, project_id) VALUES (?, ?, ?)');
  for (const m of members) ins.run(groupId, Number(m.chainId), String(m.projectId));
}

export function setGroupKey(groupId, groupKey) {
  db.prepare('UPDATE groups SET group_key = ? WHERE id = ?').run(groupKey, groupId);
}

export function groupByMember(chainId, projectId) {
  return db.prepare(`
    SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE m.chain_id = ? AND m.project_id = ?
  `).get(Number(chainId), String(projectId));
}

export function groupById(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(id));
}

export function membersOf(groupId) {
  return db.prepare('SELECT chain_id AS chainId, project_id AS projectId FROM group_members WHERE group_id = ?').all(Number(groupId));
}

export function activeGroups() {
  return db.prepare("SELECT * FROM groups WHERE status IN ('active','underfunded')").all();
}

export function setStatus(groupId, status) {
  db.prepare('UPDATE groups SET status = ? WHERE id = ?').run(status, Number(groupId));
}

export function setThreshold(groupId, thresholdPct) {
  db.prepare('UPDATE groups SET threshold_pct = ? WHERE id = ?').run(thresholdPct, Number(groupId));
}

// delta may be negative. Returns the new balance.
export function adjustBalance(groupId, deltaWei) {
  const row = db.prepare('SELECT balance_wei FROM groups WHERE id = ?').get(Number(groupId));
  const next = BigInt(row.balance_wei) + BigInt(deltaWei);
  db.prepare('UPDATE groups SET balance_wei = ? WHERE id = ?').run(next.toString(), Number(groupId));
  return next;
}

export function insertDeposit({ txHash, chainId, from, amountWei, groupId }) {
  db.prepare('INSERT INTO deposits (tx_hash, chain_id, from_address, amount_wei, group_id) VALUES (?, ?, ?, ?, ?)')
    .run(txHash.toLowerCase(), Number(chainId), from.toLowerCase(), amountWei.toString(), Number(groupId));
}

export function depositByHash(txHash) {
  return db.prepare('SELECT * FROM deposits WHERE tx_hash = ?').get(txHash.toLowerCase());
}

export function depositsByAddress(address) {
  return db.prepare('SELECT * FROM deposits WHERE from_address = ? ORDER BY credited_at DESC').all(address.toLowerCase());
}

export function insertSync({ groupId, plan, bundleUuid, quotedCostWei }) {
  const { lastInsertRowid } = db.prepare('INSERT INTO syncs (group_id, plan_json, relayr_bundle_uuid, quoted_cost_wei) VALUES (?, ?, ?, ?)')
    .run(Number(groupId), JSON.stringify(plan), bundleUuid, quotedCostWei.toString());
  return Number(lastInsertRowid);
}

export function resolveSync(id, { state, finalCostWei }) {
  db.prepare("UPDATE syncs SET state = ?, final_cost_wei = ?, resolved_at = unixepoch() WHERE id = ?")
    .run(state, finalCostWei != null ? finalCostWei.toString() : null, Number(id));
}

export function pendingSyncs() {
  return db.prepare("SELECT * FROM syncs WHERE state = 'submitted'").all();
}

// Operator remediation: move a deposit (and its credit) to another group —
// e.g. a claim that was attributed to the wrong project id.
export function reattributeDeposit(txHash, toGroupId) {
  const dep = depositByHash(txHash);
  if (!dep) throw new Error('deposit not found');
  if (dep.group_id === Number(toGroupId)) throw new Error('deposit already attributed to that group');
  adjustBalance(dep.group_id, -BigInt(dep.amount_wei));
  adjustBalance(toGroupId, BigInt(dep.amount_wei));
  db.prepare('UPDATE deposits SET group_id = ? WHERE tx_hash = ?').run(Number(toGroupId), dep.tx_hash);
  return dep;
}

// Lifetime spend for a group: reconciled cost where available, else the
// standing debit estimate of pending syncs.
export function totalCostOf(groupId) {
  const rows = db.prepare('SELECT COALESCE(final_cost_wei, quoted_cost_wei) AS c FROM syncs WHERE group_id = ?').all(Number(groupId));
  return rows.reduce((s, r) => s + BigInt(r.c || 0), 0n);
}

export function syncsOf(groupId, limit = 20) {
  return db.prepare('SELECT * FROM syncs WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(Number(groupId), limit);
}

// Edges included in this group's recent non-failed syncs — used to avoid
// re-paying for bridge messages that are still in flight.
export function recentSyncEdges(groupId, sinceSeconds) {
  const rows = db.prepare(`
    SELECT plan_json FROM syncs
    WHERE group_id = ? AND state != 'failed' AND created_at > unixepoch() - ?
  `).all(Number(groupId), sinceSeconds);
  const edges = new Set();
  for (const r of rows) {
    for (const e of JSON.parse(r.plan_json).edges || []) edges.add(`${e.from}:${e.sucker}`);
  }
  return edges;
}

// Merged service-wide feed for the landing page: syncs, deposits, and
// registrations, newest first.
export function recentActivity(limit = 20) {
  return db.prepare(`
    SELECT * FROM (
      SELECT 'sync' AS type, s.created_at AS at, g.id AS group_id, g.group_key,
             s.state AS detail, s.plan_json, COALESCE(s.final_cost_wei, s.quoted_cost_wei) AS amount_wei
        FROM syncs s JOIN groups g ON g.id = s.group_id
      UNION ALL
      SELECT 'deposit', d.credited_at, g.id, g.group_key, d.from_address, NULL, d.amount_wei
        FROM deposits d JOIN groups g ON g.id = d.group_id
      UNION ALL
      SELECT 'register', g.created_at, g.id, g.group_key, g.registrant_address, NULL, NULL
        FROM groups g
    ) ORDER BY at DESC LIMIT ?
  `).all(limit);
}
