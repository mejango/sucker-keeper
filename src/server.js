// HTTP API + the scan/finalize loops. node:http — a handful of JSON routes
// doesn't need a framework.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { isAddress, verifyMessage } from 'viem';
import * as db from './db.js';
import { isSupported, networkClass } from './chains.js';
import { walkGroup, snapshotGroup, groupKeyOf } from './mesh.js';
import { divergenceMatrix } from './monitor.js';
import { claimDeposit, httpError } from './deposits.js';
import { keeperAddress, walletBalances } from './wallet.js';
import { projectLabel } from './bendystraw.js';
import { scanAll, finalizePending } from './tick.js';

const PORT = Number(process.env.PORT || 3000);
const SCAN_INTERVAL_S = Number(process.env.SCAN_INTERVAL || 300);
let lastScan = { at: null, results: null };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) reject(httpError(413, 'body too large')); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'invalid JSON')); }
    });
  });
}

function groupView(group) {
  return {
    groupKey: group.group_key,
    members: db.membersOf(group.id),
    thresholdPct: group.threshold_pct,
    registrant: group.registrant_address,
    networkClass: group.network_class,
    balanceWei: group.balance_wei,
    totalCostWei: db.totalCostOf(group.id).toString(),
    status: group.status,
    syncs: db.syncsOf(group.id).map((s) => ({
      state: s.state, bundleUuid: s.relayr_bundle_uuid, quotedCostWei: s.quoted_cost_wei,
      finalCostWei: s.final_cost_wei, createdAt: s.created_at, plan: JSON.parse(s.plan_json),
    })),
  };
}

async function registerProject(body) {
  const { chainId, projectId, registrant } = body;
  const thresholdPct = Number(body.thresholdPct ?? 1);
  if (!isSupported(chainId)) throw httpError(400, `unsupported chain ${chainId}`);
  if (!projectId || BigInt(projectId) <= 0n) throw httpError(400, 'invalid projectId');
  if (!isAddress(registrant || '')) throw httpError(400, 'registrant must be an address');
  if (!(thresholdPct > 0 && thresholdPct <= 100)) throw httpError(400, 'thresholdPct must be in (0, 100]');

  const walk = await walkGroup(chainId, projectId);
  if (walk.members.length < 2 || walk.edges.length === 0) {
    throw httpError(422, 'project has no sucker group on supported chains — nothing to keep in sync');
  }
  const classes = new Set(walk.members.map((m) => networkClass(m.chainId)));
  if (classes.size > 1) throw httpError(422, 'group spans mainnet and testnet chains');
  for (const m of walk.members) {
    if (db.groupByMember(m.chainId, m.projectId)) throw httpError(409, 'group already registered');
  }

  const groupKey = groupKeyOf(walk.members);
  const id = db.createGroup({
    groupKey, thresholdPct, registrant, networkClass: [...classes][0], members: walk.members,
  });
  return groupView(db.groupById(id));
}

const INDEX_HTML = new URL('../web/index.html', import.meta.url);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(INDEX_HTML));
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      lastScanAt: lastScan.at,
      scanIntervalSeconds: SCAN_INTERVAL_S,
      depositAddress: keeperAddress(),
      walletBalances: url.searchParams.get('balances') ? await walletBalances() : undefined,
      groups: db.activeGroups().length,
      lastScanResults: lastScan.results,
    });
  }

  if (req.method === 'GET' && url.pathname === '/activity') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
    const rows = db.recentActivity(limit);
    const labels = new Map(); // group_id -> label (best-effort, from the group's anchor member)
    await Promise.all([...new Set(rows.map((r) => r.group_id))].map(async (gid) => {
      const m = db.membersOf(gid)[0];
      if (m) labels.set(gid, await projectLabel(m.chainId, m.projectId));
    }));
    return json(res, 200, {
      activity: rows.map((r) => ({
        type: r.type,
        at: r.at,
        groupKey: r.group_key,
        label: labels.get(r.group_id) || null,
        detail: r.detail,
        amountWei: r.amount_wei,
        edges: r.plan_json ? JSON.parse(r.plan_json).edges.map((e) => ({ from: e.from, to: e.to })) : undefined,
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/projects') {
    return json(res, 201, await registerProject(await readBody(req)));
  }

  if (req.method === 'POST' && url.pathname === '/deposits') {
    const body = await readBody(req);
    const result = await claimDeposit({
      txHash: body.txHash,
      chainId: Number(body.depositChainId ?? body.chainId),
      projectChainId: Number(body.projectChainId ?? body.chainId),
      projectId: String(body.projectId),
    });
    if (!result.pending) {
      result.label = await projectLabel(Number(body.projectChainId ?? body.chainId), String(body.projectId));
    }
    return json(res, result.pending ? 202 : 201, result);
  }

  if (parts[0] === 'projects' && parts.length === 3) {
    const group = db.groupByMember(Number(parts[1]), String(parts[2]));
    if (!group) throw httpError(404, 'not registered');

    if (req.method === 'GET') {
      const view = groupView(group);
      const anchor = view.members[0];
      if (anchor) view.label = await projectLabel(anchor.chainId, anchor.projectId);
      if (url.searchParams.get('live')) {
        const members = db.membersOf(group.id);
        const snapshots = await snapshotGroup(members);
        view.divergence = divergenceMatrix(snapshots).map((r) => ({ ...r, pct: Number(r.pct.toFixed(4)) }));
      }
      return json(res, 200, view);
    }

    if (req.method === 'PATCH') {
      const { thresholdPct, expiresAt, signature } = await readBody(req);
      if (!(thresholdPct > 0 && thresholdPct <= 100)) throw httpError(400, 'thresholdPct must be in (0, 100]');
      if (!expiresAt || expiresAt < Date.now() / 1000) throw httpError(400, 'expired or missing expiresAt');
      const message = `keeper:set-threshold:${group.group_key}:${thresholdPct}:${expiresAt}`;
      const ok = await verifyMessage({ address: group.registrant_address, message, signature }).catch(() => false);
      if (!ok) throw httpError(403, 'signature does not match registrant');
      db.setThreshold(group.id, Number(thresholdPct));
      return json(res, 200, groupView(db.groupById(group.id)));
    }
  }

  if (req.method === 'GET' && parts[0] === 'account' && parts.length === 2) {
    return json(res, 200, {
      deposits: db.depositsByAddress(parts[1]).map((d) => ({
        txHash: d.tx_hash, chainId: d.chain_id, amountWei: d.amount_wei, creditedAt: d.credited_at,
      })),
    });
  }

  throw httpError(404, 'not found');
}

export function start() {
  db.init();
  console.log(JSON.stringify({ keeperWallet: keeperAddress() })); // fails fast if KEEPER_PRIVATE_KEY is missing
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      json(res, err.status || 500, { error: err.message });
      if (!err.status) console.log(JSON.stringify({ at: req.url, error: err.message }));
    });
  });
  server.listen(PORT, () => console.log(JSON.stringify({ listening: PORT })));

  let scanning = false;
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      lastScan = { at: Math.floor(Date.now() / 1000), results: await scanAll() };
      console.log(JSON.stringify({ scan: lastScan }));
    } finally { scanning = false; }
  };
  setInterval(scan, SCAN_INTERVAL_S * 1000).unref();
  setInterval(() => finalizePending().catch(() => {}), 60_000).unref();
  scan();
  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) start();
