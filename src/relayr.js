// Relayr prepaid execution. The keeper submits plain transactions
// (syncAccountingData is permissionless — no forwarding, no signatures, no API
// key), gets back payment options, and pays one from its own wallet. Modelled
// on website/src/relayr.js.
const API = () => process.env.RELAYR_API || 'https://api.relayr.ba5ed.com';

async function relayrFetch(path, opts = {}) {
  const res = await fetch(API() + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      // Optional for prepaid bundles; attaches the org identity when provided.
      ...(process.env.RELAYR_API_KEY ? { 'x-api-key': process.env.RELAYR_API_KEY } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error(`relayr ${opts.method || 'GET'} ${path} HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

// transactions: [{chain, target, data, value: bigint}]
// -> { bundleUuid, paymentInfo: [{chain, target, amount, calldata, token, payment_deadline}] }
// Sync edges are independent (distinct suckers), so no virtual-nonce ordering.
export async function submitPrepaidBundle(transactions) {
  const body = {
    virtual_nonce_mode: 'Disabled',
    transactions: transactions.map((t) => ({
      chain: Number(t.chain),
      target: t.target,
      data: t.data,
      value: t.value.toString(),
    })),
  };
  const res = await relayrFetch('/v1/bundle/prepaid', { method: 'POST', body: JSON.stringify(body) });
  return { bundleUuid: res.bundle_uuid, paymentInfo: res.payment_info || [] };
}

export function getBundle(uuid) {
  return relayrFetch(`/v1/bundle/${uuid}`);
}

export function txState(tx) {
  return tx?.status?.state; // 'Success' | 'Failed' | pending states
}

export function txDestHash(tx) {
  return tx?.status?.data?.hash || tx?.status?.data?.transaction?.hash || null;
}
