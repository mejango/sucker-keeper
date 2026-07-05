// On-chain group discovery and accounting snapshots. A project's ID differs per
// chain; the canonical identity is the sucker group, resolved by BFS-walking
// suckerPairsOf -> remote sucker.projectId() across chains.
import { encodeAbiParameters, decodeAbiParameters } from 'viem';
import { clientFor, isSupported, SUCKER_REGISTRY, SUCKER_LIB, DIRECTORY } from './chains.js';
import { REGISTRY_ABI, SUCKER_ABI, SNAPSHOT_RETURN } from './abi.js';

// External library selectors hash the Solidity type NAMES (IJBDirectory, ...),
// not their canonical ABI types, so viem's readContract computes the wrong
// selector. Taken from the forge artifact's methodIdentifiers:
//   buildAccountingSnapshot(IJBDirectory,IJBSuckerRegistry,uint256,uint256,uint8,uint256)
const BUILD_SNAPSHOT_SELECTOR = '0xf1d0f277';
const BUILD_SNAPSHOT_PARAMS = [
  { type: 'address' }, { type: 'address' }, { type: 'uint256' },
  { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' },
];

export function bytes32ToAddress(b32) {
  return `0x${b32.slice(-40)}`.toLowerCase();
}

export function groupKeyOf(members) {
  return members
    .map((m) => `${m.chainId}:${m.projectId}`)
    .sort((a, b) => {
      const [ca, pa] = a.split(':').map(BigInt);
      const [cb, pb] = b.split(':').map(BigInt);
      return ca === cb ? (pa < pb ? -1 : 1) : ca < cb ? -1 : 1;
    })[0];
}

// BFS from any (chainId, projectId). Returns:
//   members: [{chainId, projectId}]
//   edges:   [{from, to, sucker}]  — sucker is the contract to call on `from`
//   unsupported: chainIds referenced by pairs but not configured here
export async function walkGroup(chainId, projectId) {
  const members = new Map(); // chainId -> projectId (string)
  const edges = [];
  const unsupported = new Set();
  const queue = [[Number(chainId), String(projectId)]];

  while (queue.length) {
    const [cid, pid] = queue.shift();
    if (members.has(cid)) continue;
    members.set(cid, pid);

    const client = clientFor(cid);
    const pairs = await client.readContract({
      address: SUCKER_REGISTRY, abi: REGISTRY_ABI, functionName: 'suckerPairsOf', args: [BigInt(pid)],
    });

    for (const pair of pairs) {
      const remoteChainId = Number(pair.remoteChainId);
      edges.push({ from: cid, to: remoteChainId, sucker: pair.local.toLowerCase() });
      if (!isSupported(remoteChainId)) { unsupported.add(remoteChainId); continue; }
      if (members.has(remoteChainId)) continue;
      const remoteSucker = bytes32ToAddress(pair.remote);
      const remotePid = await clientFor(remoteChainId).readContract({
        address: remoteSucker, abi: SUCKER_ABI, functionName: 'projectId',
      });
      queue.push([remoteChainId, String(remotePid)]);
    }
  }

  return {
    members: [...members.entries()].map(([cid, pid]) => ({ chainId: cid, projectId: pid })),
    edges: edges.filter((e) => isSupported(e.to)),
    unsupported: [...unsupported],
  };
}

// One eth_call per chain: the chain's own live accounting record plus its
// stored beliefs about every peer chain, straight from JBSuckerLib.
export async function snapshotChain(chainId, projectId) {
  const data = BUILD_SNAPSHOT_SELECTOR + encodeAbiParameters(
    BUILD_SNAPSHOT_PARAMS,
    [DIRECTORY, SUCKER_REGISTRY, BigInt(projectId), 0n, 1, 0n],
  ).slice(2);
  const { data: ret } = await clientFor(chainId).call({ to: SUCKER_LIB, data });
  const [snapshot] = decodeAbiParameters(SNAPSHOT_RETURN, ret);
  const [truth, ...rest] = snapshot.accounts;
  const beliefs = new Map(); // sourceChainId -> account record
  for (const acc of rest) beliefs.set(Number(acc.chainId), acc);
  return { chainId: Number(chainId), truth, beliefs };
}

// Snapshot every member chain. Throws if any chain read fails — the caller
// skips the group this round rather than planning from partial state.
export async function snapshotGroup(members) {
  const snaps = await Promise.all(members.map((m) => snapshotChain(m.chainId, m.projectId)));
  const byChain = new Map();
  for (const s of snaps) byChain.set(s.chainId, s);
  return byChain;
}
