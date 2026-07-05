// Best-effort project labels from Bendystraw, so the activity feed reads
// "Revnet Network (REV)" instead of "84532:3". Server-side queries need no
// CORS key; BENDYSTRAW_KEY is optional (falls back to the public key the
// website ships). V6 Project.name/handle are unresolved in the indexer today,
// so the ERC-20 deploy event is the reliable label source. Failures return
// null — the feed renders fine without labels.
import { networkClass } from './chains.js';

const PUBLIC_KEY = '3ZNJpGtazh5fwYoSW59GWDEj';
const cache = new Map(); // `${chainId}:${projectId}` -> { label, at }
const TTL_MS = 24 * 3600 * 1000;

function endpoint(chainId) {
  const host = networkClass(chainId) === 'testnet' ? 'https://testnet.bendystraw.xyz' : 'https://bendystraw.xyz';
  return `${host}/${process.env.BENDYSTRAW_KEY || PUBLIC_KEY}/graphql`;
}

export async function projectLabel(chainId, projectId) {
  const key = `${chainId}:${projectId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.label;

  let label = null;
  try {
    const res = await fetch(endpoint(chainId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ project(chainId: ${Number(chainId)}, projectId: ${Number(projectId)}, version: 6) {
          name handle isRevnet deployErc20Events { items { symbol name } } } }`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const project = (await res.json())?.data?.project;
    if (project) {
      const erc20 = project.deployErc20Events?.items?.[0];
      label = project.name || project.handle || erc20?.name || (erc20?.symbol ? `$${erc20.symbol}` : null);
      if (label && project.isRevnet) label += ' (revnet)';
    }
  } catch {}
  cache.set(key, { label, at: Date.now() });
  return label;
}
