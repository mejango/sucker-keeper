# Keeper — omnichain sucker sync service

**Date**: 2026-07-04 · **Status**: approved design

A small server (deployed to Railway) that anyone can register an omnichain Juicebox project / revnet with. Registrants fund a gas balance and set a diff threshold; the keeper watches each chain's view of every other chain's accounting and, when views diverge past the threshold, executes the cheapest set of `syncAccountingData()` calls — routed through the suckers' gossip mesh — via Relayr.

## Scope decisions (locked)

- **Sync scope**: accounting gossip only (`JBSucker.syncAccountingData()`). Outbox merkle roots (`toRemote`) stay user-initiated.
- **Funding**: API registration + pay-to-address. Deposits are ETH sent to the keeper's wallet on any supported chain, claimed by tx hash **signed by the sending address** (unsigned claims would be front-runnable — first-come-first-served on a public hash).
- **Sponsorships** (revised 2026-07-05): any address sponsors any project with its own threshold (default 1%) and balance; non-exclusive. Min funded threshold governs; costs split evenly among triggered sponsors; deposits credit the sender's own sponsorship.
- **Chains**: the V6 mainnets (Ethereum, Optimism, Base, Arbitrum) + their Sepolia testnets. Mainnet and testnet balances are separate ledgers (testnet ETH is worthless).
- **Execution**: Relayr **prepaid mode** (`POST /v1/bundle/prepaid`, no API key) paid from the keeper's own hot wallet (`KEEPER_PRIVATE_KEY`). The wallet's address doubles as the deposit address, so the service is fully self-managing: registrants fund the same pot the keeper pays Relayr from. (Balance mode was considered but its org balance has no top-up API — it would leave a manual ops step.) Relayr quotes the exact bundle cost *before* payment, so group billing = quote + payment-tx gas, reconciled to receipts. The keeper doesn't bridge its own funds between chains; `/health?balances=1` exposes per-chain wallet balances for manual rebalancing.
- **UI**: the keeper serves a single-page site at `/` (recent-activity feed, register, fund via wallet or tx-hash claim, live divergence monitoring, signed threshold updates), styled after the `website/` directory aesthetic.

## Why this works (sucker mechanics)

- `syncAccountingData()` is **permissionless and payable**: it bundles the local chain's own accounting record (total supply incl. reserved, per-context surplus/balance) plus every peer record the sucker already holds, and sends it to that sucker's single direct peer (`peerChainId()`).
- Receivers keep the **freshest record per source chain** (monotonic source timestamps), so records propagate transitively across the mesh — one well-placed sync refreshes a chain's view of many sources.
- Because the call is permissionless, the keeper submits **plain transactions** to Relayr (`{chain, target: sucker, data, value: bridgeFee}`) — no ERC-2771 forwarding, no signatures.
- **Project identity is per-chain**: the same omnichain project has a *different* `projectId` on each chain. The canonical identity is the **sucker group**, resolved on-chain: from any `(chainId, projectId)`, `suckerPairsOf` returns each pair's `{remote, remoteChainId}`, and the remote sucker's public `projectId()` view gives that chain's local ID — BFS-walk until the member set closes. No Bendystraw dependency for identity: the walk is authoritative and live, whereas Bendystraw `suckerGroupId`s are point-in-time (groups merge over time). Bendystraw IS used — best-effort, server-side, cached 24h — for display labels in the activity feed and group views (`src/bendystraw.js`; V6 `Project.name` is unresolved in the indexer today, so labels come from `deployErc20Events` name/symbol).
- **Reading state**: `JBSuckerLib.buildAccountingSnapshot(directory, registry, projectId, exceptChainId, version, timestamp)` is an external library **view** whose reads all flow through its arguments (pass each chain's *local* project ID). One `eth_call` to the deployed library per chain returns that chain's actual local record **and** its stored beliefs about every peer — the full divergence matrix in N calls for N chains. Gotcha (hit in implementation): external library selectors hash Solidity type *names* (`IJBDirectory`, …), not canonical ABI types, so the call uses the artifact-derived selector `0xf1d0f277` with standard param/return encoding.
- **Bridge fees**: OP-family accounting messages need `value = 0`. CCIP needs a tight native fee (excess refunds to the *caller* — Relayr's relayer, not us); quoted by `eth_call`-probing `syncAccountingData` with candidate values. Arbitrum L1→L2 retryables need a small native fee, quoted the same way.

## Architecture

One Node process, plain ESM JavaScript + `viem` (same stack as `website/`), zero build step.

```
keeper/
  src/
    server.js      # node:http JSON API + starts the monitor loop
    db.js          # node:sqlite schema + queries (file on Railway volume /data)
    chains.js      # chain configs: RPCs, registry/library addresses, bridge family per edge
    monitor.js     # per-project divergence scan (the eth_call fan-out)
    planner.js     # gossip-aware sync planning (Dijkstra + path union + hop waves)
    relayr.js      # prepaid bundle submit + poll (adapted from website/src/relayr.js)
    wallet.js      # keeper hot wallet: deposit address, payment-option selection, paying Relayr
    tick.js        # scan/execute/finalize loop bodies
    deposits.js    # tx-hash claim verification + crediting
  test/            # node:test — planner/divergence (pure), db billing, HTTP API, tick, quoting, relayr wire format (chain + Relayr layers module-mocked)
  web/index.html   # self-contained UI served at GET / (register, fund, monitor, threshold)
  DESIGN.md
  README.md
  Dockerfile (or nixpacks auto-detect)
```

No framework, no ORM, no queue. The monitor loop is `setInterval` in-process (Railway restarts resume cleanly from SQLite state).

## Data model (SQLite, 4 tables)

Identity and billing are **group-scoped** — one row, one balance, one threshold per omnichain project group, no matter which chain's ID was used to register or fund it.

- `groups` — `(id, group_key UNIQUE, threshold_pct, registrant_address, network_class mainnet|testnet, balance_wei, status active|underfunded|paused, created_at)`. `group_key` = the lexicographically smallest `chainId:projectId` member — stable as long as that member exists; if a walk ever produces a new smaller member (group grew), the key is migrated in place.
- `group_members` — `(group_id, chain_id, project_id, UNIQUE(chain_id, project_id))`. Written at registration, refreshed on every scan's mesh walk (groups can gain chains later). Any member resolves the group for API lookups and deposit crediting.
- `deposits` — `(tx_hash UNIQUE, chain_id, from_address, amount_wei, group_id, credited_at)`.
- `syncs` — `(id, group_id, plan_json, relayr_bundle_uuid, quoted_cost_wei, final_cost_wei, state submitted|success|failed, created_at, resolved_at)`.

Balances belong to **groups**, not payers — anyone can top up any registered project, referencing it by any of its per-chain IDs.

## Monitor loop

Every `SCAN_INTERVAL` (default 5 min), for each `active` group:

1. Discover the mesh: BFS walk from any stored member — `suckerPairsOf(localProjectId)` on each discovered chain, resolving each remote sucker's `projectId()` — yielding nodes (chains, each with its local project ID) + edges (sucker pairs, each edge = two directed sends: local sucker → its peer). Refresh `group_members` from the walk.
2. Snapshot every chain: one `eth_call` per chain to `JBSuckerLib.buildAccountingSnapshot`.
3. Divergence: for every ordered pair (source S, viewer V): compare V's stored record of S against S's own record, field-by-field (`totalSupply`, each context's `surplus` and `balance`). `diff% = |actual − believed| / max(actual, 1)`. V having **no record** of S while S has nonzero supply counts as 100% divergent. Any field ≥ threshold → stale pair `(S, V)`.
4. If any stale pairs and balance covers the plan estimate → plan and execute. If balance is short → mark `underfunded` (recovers automatically on deposit).

## Gossip-aware planning (the economical part)

Goal: the cheapest ordered set of `syncAccountingData()` calls such that, after propagation, every stale `(S, V)` view is refreshed.

- Graph: nodes = project's chains; directed edge X→Y exists where X has a sucker whose peer is on Y (parallel native/CCIP edges are common — Dijkstra picks the cheaper). Edge weight = probed transport fee + origin-chain execution gas + a flat hop penalty — pricing execution gas steers plans away from Ethereum-L1-origin syncs.
- **Hub consolidation**: per-pair shortest paths overcount when pairs could share edges (a sync forwards everything the sender holds). The planner also prices routing every stale source into each candidate hub and the hub out to every stale viewer, and takes whichever shape has the cheaper unique-edge total — full-CCIP meshes then touch L1 via at most one inbound + one outbound edge per round.
- **Edge usability**: native-bridge messages INTO an L1 (OP prove+finalize, Arb outbox execution) don't self-deliver, so native L2→L1 edges are excluded — L1 views refresh via CCIP edges. Transport fees are quoted with one universal probe: `eth_call syncAccountingData{value}` from a state-overridden address, `0` first (OP-family, Arb L2→L1), binary-searched otherwise (CCIP `router.getFee`, Arb retryables) + 5% pad. The probe also drops deprecated/paused suckers for free.
- For each stale source S: Dijkstra from S to every stale viewer V of S. Take the union of edges across all paths and all sources — **shared edges are free extra coverage**, since one sync carries every record the sender holds.
- **Round-based execution** (no in-process waiting): each scan tick submits only the path edges that are *ready* — the sender already holds data within threshold of the source's truth while the receiver doesn't. Bridge messages land between ticks; the next tick pushes the next hop. Idempotent and restart-safe; full-mesh groups converge in one round, hub-and-spoke in ≤ diameter rounds.

`planner.js` is pure (graph in → waves out) and unit-tested with `node:test`.

## Execution (Relayr prepaid, keeper-wallet paid)

- Build transactions `{chain, target: sucker, data: encodeFunctionData(syncAccountingData), value: quotedBridgeFee}` — edges in a round are independent, so `virtual_nonce_mode: Disabled`.
- `POST /v1/bundle/prepaid` (no API key) returns payment options; a bundle is a free quote until paid. If the group can't afford the cheapest option, it expires unpaid and the group is marked `underfunded`.
- The keeper wallet pays the option on the supported chain (matching the group's network class) where it holds the most funds, then the finalize loop polls `GET /v1/bundle/{uuid}` until all txs settle (or fail → sync `failed`, retried next scan).
- Cost: debit = payment amount + payment-gas allowance at submit, reconciled to the payment receipt at finalize. At-cost, no margin.

## HTTP API (node:http, JSON)

All project endpoints accept **any** member `(chainId, projectId)` and resolve to the group.

- `POST /projects` `{chainId, projectId, thresholdPct?, registrant}` → walks the mesh, registers the group with all members (409 if the group — under any member — is already registered). No auth — funding is the spam gate; unfunded groups are never synced.
- `POST /deposits` `{txHash, chainId, projectId}` → verifies the tx (to == deposit address, ≥1 confirmation on the claimed chain, not already claimed), credits the resolved group's ledger for its network class. The deposit chain doesn't need to match the referenced member's chain.
- `PATCH /projects/:chainId/:projectId` `{thresholdPct, signature}` — EIP-191 signature from the original registrant over a canonical message.
- `GET /projects/:chainId/:projectId` → group members, status, balance, live divergence matrix, sync history.
- `GET /account/:address` → deposits made by that address.
- `GET /health` → scan-loop heartbeat + per-chain RPC status.

Deposit address: a keeper-controlled address (env `DEPOSIT_ADDRESS`) that only ever receives — no keys on the server.

## Config / deploy (Railway)

Env: `RELAYR_API`, `KEEPER_PRIVATE_KEY` (hot wallet = deposit address = Relayr payer), per-chain `RPC_<chainId>` (with public-RPC defaults), `SCAN_INTERVAL`, `DB_PATH=/data/keeper.db`. Railway volume mounted at `/data`. Single service, no cron add-ons.

## Failure handling

- RPC read failure on a chain → skip that group's scan this round (never plan from partial state).
- Relayr bundle failure → sync marked `failed`, balance re-credited for unexecuted quoted cost, retried next scan.
- Sucker deprecation (`_requireSendingEnabled` reverts) or emergency states → simulation catches it at quote time; the edge is dropped from the graph for that scan.
- Double-spend of deposits prevented by `tx_hash UNIQUE`.

## Testing

- `node:test` unit tests for `planner.js` (path union, wave ordering, shared-edge dedup) and divergence math — pure functions, no network.
- One integration smoke script against testnets: register a sepolia↔op-sepolia project, force a divergence read, assert the planner emits the expected single edge (execution behind a `--live` flag).

## Out of scope (v1)

Balance withdrawals/refunds, cost margins, `toRemote` outbox relaying, email/webhook alerts, a UI, historical analytics, LINK-funded CCIP fee mode. Add when someone asks.
