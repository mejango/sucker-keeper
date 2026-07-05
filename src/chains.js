// Chain configs. All JB V6 contracts deploy deterministically, so the three
// addresses below are identical on every supported chain (verified against
// deploy-all-v6/deployments/*/).
import { createPublicClient, http } from 'viem';

export const SUCKER_REGISTRY = '0x7903a854ae91eaf635430d120a1a434085cef297';
export const SUCKER_LIB = '0x0b2b545a4e2fd65d29f2417f1b26698d71769a8f';
export const DIRECTORY = '0x5aff29060e023e6fb87be5596652b33c65af535b';

export const CHAINS = {
  1: { name: 'ethereum', testnet: false, l1: true, rpc: 'https://ethereum-rpc.publicnode.com' },
  10: { name: 'optimism', testnet: false, l1: false, rpc: 'https://optimism-rpc.publicnode.com' },
  8453: { name: 'base', testnet: false, l1: false, rpc: 'https://base-rpc.publicnode.com' },
  42161: { name: 'arbitrum', testnet: false, l1: false, rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  11155111: { name: 'sepolia', testnet: true, l1: true, rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  11155420: { name: 'optimism-sepolia', testnet: true, l1: false, rpc: 'https://optimism-sepolia-rpc.publicnode.com' },
  84532: { name: 'base-sepolia', testnet: true, l1: false, rpc: 'https://base-sepolia-rpc.publicnode.com' },
  421614: { name: 'arbitrum-sepolia', testnet: true, l1: false, rpc: 'https://arbitrum-sepolia-rpc.publicnode.com' },
};

export function isSupported(chainId) {
  return Boolean(CHAINS[Number(chainId)]);
}

export function networkClass(chainId) {
  return CHAINS[Number(chainId)].testnet ? 'testnet' : 'mainnet';
}

export function isL1(chainId) {
  return Boolean(CHAINS[Number(chainId)]?.l1);
}

export function rpcFor(chainId) {
  const cfg = CHAINS[Number(chainId)];
  if (!cfg) throw new Error(`unsupported chain ${chainId}`);
  return process.env[`RPC_${Number(chainId)}`] || cfg.rpc;
}

export function viemChainFor(chainId) {
  const id = Number(chainId);
  return {
    id,
    name: CHAINS[id].name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcFor(id)] } },
  };
}

const clients = {};

export function clientFor(chainId) {
  const id = Number(chainId);
  if (!clients[id]) {
    clients[id] = createPublicClient({ transport: http(rpcFor(id), { retryCount: 2 }) });
  }
  return clients[id];
}
