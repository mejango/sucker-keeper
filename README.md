# keeper

Keeps omnichain Juicebox projects' sucker accounting in sync across chains, automatically.

Anyone can register a project (or revnet) that has suckers, fund a gas balance, and set a divergence threshold. The keeper watches every chain's view of every other chain's accounting (total supply, per-context surplus/balance) and, when views drift past the threshold, executes the cheapest set of permissionless `syncAccountingData()` calls via [Relayr](https://docs.relayr.dev) — routed through the suckers' gossip mesh so one sync refreshes as many views as possible.

The keeper serves a web UI at `/` for registration, funding, threshold updates, and live divergence monitoring. Design details: [DESIGN.md](./DESIGN.md). Chains: Ethereum, Optimism, Base, Arbitrum + their Sepolias.

## API

Projects are identified by **any** of their per-chain `(chainId, projectId)` pairs — IDs differ per chain; the keeper resolves the omnichain group on-chain.

**Sponsorships, not exclusive registrations**: any address can sponsor any project with its own threshold and its own balance — sponsoring never blocks anyone else. The tightest funded threshold governs when syncs fire, and each sync's cost splits evenly among the sponsors whose thresholds triggered it.

```
POST /projects            {chainId, projectId, sponsor, thresholdPct?=1}   # adds YOUR sponsorship
POST /deposits            {txHash, depositChainId, projectChainId, projectId, expiresAt, signature}
GET  /projects/:chainId/:projectId[?live=1]     # group, sponsors, syncs; live adds divergence matrix
PATCH /projects/:chainId/:projectId             {sponsor, thresholdPct, expiresAt, signature}
GET  /account/:address    # sponsorships + deposits of an address
GET  /activity[?limit=20] # service-wide feed: syncs, deposits, registrations (Bendystraw-labeled)
GET  /health
```

**Funding**: send ETH to the keeper's wallet address (shown at `GET /health` and on the web UI) on any supported chain of the group's network class (mainnet groups need mainnet ETH), then claim the tx hash via `POST /deposits`. **Claims must be EIP-191-signed by the sending address** over `keeper:claim:{txHash}:{projectChainId}:{projectId}:{expiresAt}` — nobody can front-run and claim your deposit, and the credit lands on your own sponsorship (created on the fly if new). Only direct EOA transfers verify, and the sender must be able to sign (no exchange withdrawals). Testnet and mainnet balances are separate ledgers.

**Threshold changes**: EIP-191 signature by the sponsor over
`keeper:set-threshold:{groupKey}:{thresholdPct}:{expiresAt}` — affects only that sponsor's threshold.

## How it syncs

Each scan (default 5 min) the keeper walks the group's sucker mesh, snapshots every chain in one `eth_call` (`JBSuckerLib.buildAccountingSnapshot` returns the chain's own record *plus* its stored beliefs about every peer), and computes the divergence matrix. For stale views it plans the cheapest edge SET through the mesh — per-pair shortest paths versus consolidation through a hub chain, whichever prices lower on unique edges (edge costs include origin-chain execution gas, so Ethereum L1 ideally sees one inbound and one outbound sync per round while L2s gossip the rest) and submits one Relayr prepaid bundle with the edges that are ready this round, paid from the keeper's own wallet — multi-hop propagation continues on later scans as bridge messages land. Relayr quotes the exact bundle cost before payment; groups are debited that quote plus payment gas, reconciled to receipts. At cost, no margin.

Bridge specifics the planner knows: OP-family accounting sends take `value = 0`; Arbitrum L1→L2 retryables need a small fee (quoted by eth_call probe); CCIP fees are quoted the same way with a 5% pad; native-bridge L2→L1 messages don't self-deliver (prove/finalize, outbox) so those edges are excluded — L1 views refresh via CCIP.

## Run

```sh
cp .env.example .env   # set KEEPER_PRIVATE_KEY (cast wallet new); RELAYR_API_KEY optional (x-api-key)
node src/server.js     # needs node >= 23.4 (node:sqlite)
npm test               # 46 tests: planner, divergence, billing/db, HTTP API, tick, quoting, relayr wire format (no network)
node scripts/smoke.js 11155111 1   # read-only live pipeline check against a real group
```

**Railway**: deploy the Dockerfile, mount a volume at `/data`, set `KEEPER_PRIVATE_KEY`. The keeper is self-funding: registrant deposits land in its wallet and it pays Relayr prepaid bundles from the same wallet. It does not bridge its own funds between chains — watch `GET /health?balances=1` and rebalance manually if one chain runs dry.

## Notes / v1 ceilings

- No balance withdrawals, no margin on costs, no `toRemote` (token-claim) relaying, no alerts. Add when someone asks.
- The external-library eth_call in `src/mesh.js` uses a hardcoded selector `0xf1d0f277` — external library selectors hash Solidity type names (`IJBDirectory`, …), not canonical ABI types. Recompute from the forge artifact's `methodIdentifiers` if `JBSuckerLib` is ever redeployed with a changed signature.
