// Divergence math — pure functions over snapshots.

// Percent difference of two BigInts relative to `actual`, in basis-point
// precision returned as a float percent. actual == 0 && believed == 0 -> 0.
export function diffPct(actual, believed) {
  const a = BigInt(actual);
  const b = BigInt(believed);
  if (a === b) return 0;
  const base = a > 0n ? a : 1n;
  const d = a > b ? a - b : b - a;
  return Number((d * 10000n) / base) / 100;
}

// Contexts carry raw un-valued amounts that are unchanged by gossip forwarding;
// only the token KEY may be remapped by hubs. So compare as multisets of
// (decimals, surplus, balance), pairing after a stable sort.
// ponytail: same-decimals contexts with close amounts can mispair after sort,
// over-reporting divergence for one tick; harmless (triggers at most one extra
// sync). Match by token-mapping tables if it ever matters.
export function contextsDiffPct(actualContexts, believedContexts) {
  if (actualContexts.length !== believedContexts.length) return 100;
  const key = (c) => [Number(c.decimals), BigInt(c.surplus), BigInt(c.balance)];
  const cmp = (x, y) => {
    const [dx, sx, bx] = key(x); const [dy, sy, by] = key(y);
    if (dx !== dy) return dx - dy;
    if (sx !== sy) return sx < sy ? -1 : 1;
    if (bx !== by) return bx < by ? -1 : 1;
    return 0;
  };
  const as = [...actualContexts].sort(cmp);
  const bs = [...believedContexts].sort(cmp);
  let max = 0;
  for (let i = 0; i < as.length; i++) {
    max = Math.max(max, diffPct(as[i].surplus, bs[i].surplus), diffPct(as[i].balance, bs[i].balance));
  }
  return max;
}

// For every ordered (source, viewer) pair, how far the viewer's stored record
// of the source diverges from the source's live truth.
export function divergenceMatrix(snapshotsByChain) {
  const chains = [...snapshotsByChain.keys()];
  const rows = [];
  for (const source of chains) {
    const truth = snapshotsByChain.get(source).truth;
    for (const viewer of chains) {
      if (viewer === source) continue;
      const belief = snapshotsByChain.get(viewer).beliefs.get(source);
      let pct;
      if (!belief) {
        // No record at all: fully divergent unless the source is genuinely empty.
        pct = BigInt(truth.totalSupply) === 0n && truth.contexts.every((c) => BigInt(c.balance) === 0n) ? 0 : 100;
      } else {
        pct = Math.max(
          diffPct(truth.totalSupply, belief.totalSupply),
          contextsDiffPct(truth.contexts, belief.contexts),
        );
      }
      rows.push({ source, viewer, pct });
    }
  }
  return rows;
}

export function stalePairs(matrix, thresholdPct) {
  return matrix.filter((r) => r.pct >= thresholdPct);
}
