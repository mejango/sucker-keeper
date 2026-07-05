// Per-edge transport-fee quoting and usability.
//
// syncAccountingData's msg.value requirement differs by bridge family:
//   OP-family:        must be exactly 0
//   Arb L2 -> L1:     must be exactly 0
//   Arb L1 -> L2:     must be > 0 (retryable ticket funding)
//   CCIP:             must be >= router.getFee (excess refunded to the CALLER,
//                     i.e. Relayr's relayer — so quotes must be tight)
//
// One universal probe covers all of them: eth_call the sync with a candidate
// value from a state-overridden rich address. 0 first, binary search up
// otherwise. The probe also catches deprecated/paused suckers for free.
//
// Native-bridge messages INTO an L1 (OP prove+finalize, Arb outbox execution)
// don't self-deliver — someone must relay them on L1, which the keeper doesn't
// do. Those edges are excluded; L1 views refresh via CCIP edges instead.
import { encodeFunctionData, parseEther } from 'viem';
import { clientFor, isL1 } from './chains.js';
import { SUCKER_ABI } from './abi.js';

const SYNC_CALLDATA = encodeFunctionData({ abi: SUCKER_ABI, functionName: 'syncAccountingData' });
const PROBE_FROM = '0x000000000000000000000000000000000000dEaD';
const PROBE_MAX = parseEther('0.1');

const familyCache = new Map(); // `${chainId}:${sucker}` -> 'ccip' | 'native'

async function familyOf(chainId, sucker) {
  const key = `${chainId}:${sucker}`;
  if (!familyCache.has(key)) {
    try {
      await clientFor(chainId).readContract({ address: sucker, abi: SUCKER_ABI, functionName: 'CCIP_ROUTER' });
      familyCache.set(key, 'ccip');
    } catch {
      familyCache.set(key, 'native');
    }
  }
  return familyCache.get(key);
}

async function probe(chainId, sucker, value) {
  try {
    await clientFor(chainId).call({
      to: sucker,
      data: SYNC_CALLDATA,
      value,
      account: PROBE_FROM,
      stateOverride: [{ address: PROBE_FROM, balance: parseEther('1000') }],
    });
    return true;
  } catch {
    return false;
  }
}

// -> { usable, value?, family, reason? }
export async function quoteEdge({ from, to, sucker }) {
  const family = await familyOf(from, sucker);
  if (family === 'native' && isL1(to)) {
    return { usable: false, family, reason: 'native-l2-to-l1-needs-manual-relay' };
  }
  if (await probe(from, sucker, 0n)) return { usable: true, family, value: 0n };
  if (!(await probe(from, sucker, PROBE_MAX))) {
    return { usable: false, family, reason: 'sync-reverts-at-any-value' };
  }
  // Binary-search the minimal accepted value, then pad for fee drift between
  // our probe and Relayr's later simulation/execution — CCIP's getFee and
  // Arbitrum's retryable submission cost both track gas prices, and an
  // underquoted tx gets the whole bundle rejected (406 SimulationReverted).
  // Arb retryables are the most volatile (submission cost scales with L1
  // basefee), so native nonzero fees get 2x; CCIP gets 20%. The pads are
  // small certain overpayments (refunded to Relayr's relayer / the L2 refund
  // address) that buy bundle reliability.
  let lo = 0n; // known-failing
  let hi = PROBE_MAX; // known-passing
  // Iterate to ~2% relative precision — a fixed iteration count leaves the
  // result dominated by search granularity when the true fee is small.
  for (let i = 0; i < 30 && hi - lo > hi / 50n + 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (await probe(from, sucker, mid)) hi = mid;
    else lo = mid;
  }
  const padPct = family === 'ccip' ? 120n : 200n;
  return { usable: true, family, value: (hi * padPct) / 100n };
}
