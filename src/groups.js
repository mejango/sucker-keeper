// Group resolution shared by registration and deposit claiming: find the
// omnichain group for any (chainId, projectId), walking the sucker mesh and
// creating the group when it's new. Registration is free, so funding can
// register implicitly — one flow.
import { isSupported, networkClass } from './chains.js';
import { walkGroup, groupKeyOf } from './mesh.js';
import { httpError } from './deposits.js';
import * as db from './db.js';

export async function ensureGroup(chainId, projectId, seedSponsor) {
  if (!isSupported(chainId)) throw httpError(400, `unsupported chain ${chainId}`);
  if (!projectId || BigInt(projectId) <= 0n) throw httpError(400, 'invalid projectId');

  let group = db.groupByMember(chainId, projectId);
  if (group) return group;

  const walk = await walkGroup(chainId, projectId);
  if (walk.members.length < 2 || walk.edges.length === 0) {
    throw httpError(422, 'project has no sucker group on supported chains — nothing to keep in sync');
  }
  const classes = new Set(walk.members.map((m) => networkClass(m.chainId)));
  if (classes.size > 1) throw httpError(422, 'group spans mainnet and testnet chains');
  for (const m of walk.members) {
    const existing = db.groupByMember(m.chainId, m.projectId);
    if (existing) return existing;
  }
  const id = db.createGroup({
    // registrant is a legacy column; sponsorships carry the real ownership.
    groupKey: groupKeyOf(walk.members), thresholdPct: 1,
    registrant: seedSponsor || '0x0000000000000000000000000000000000000000',
    networkClass: [...classes][0], members: walk.members,
  });
  return db.groupById(id);
}
