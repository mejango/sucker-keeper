// Hand-written ABI fragments for the on-chain surfaces the keeper touches.
// Shapes verified against nana-suckers-v6 source.

export const REGISTRY_ABI = [
  {
    type: 'function', name: 'suckerPairsOf', stateMutability: 'view',
    inputs: [{ name: 'projectId', type: 'uint256' }],
    outputs: [{
      name: 'pairs', type: 'tuple[]', components: [
        { name: 'local', type: 'address' },
        { name: 'remote', type: 'bytes32' },
        { name: 'remoteChainId', type: 'uint256' },
      ],
    }],
  },
];

export const SUCKER_ABI = [
  { type: 'function', name: 'projectId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'peerChainId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'peer', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'syncAccountingData', stateMutability: 'payable', inputs: [], outputs: [] },
  // Only present on CCIP suckers — used as a bridge-family probe.
  { type: 'function', name: 'CCIP_ROUTER', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

// JBSuckerLib is an external-linked library whose view functions read state only
// through their arguments, so it can be eth_call'd directly at its deployed
// address (mesh.js carries the artifact-derived selector — external library
// selectors hash interface type names, not canonical ABI types). The call
// returns accounts[0] = the chain's own live record and accounts[1..] = its
// stored beliefs about every peer chain. Return layout for decoding:
export const SNAPSHOT_RETURN = [{
  name: 'snapshot', type: 'tuple', components: [
    { name: 'version', type: 'uint8' },
    {
      name: 'accounts', type: 'tuple[]', components: [
        { name: 'chainId', type: 'uint256' },
        { name: 'totalSupply', type: 'uint256' },
        {
          name: 'contexts', type: 'tuple[]', components: [
            { name: 'token', type: 'bytes32' },
            { name: 'decimals', type: 'uint8' },
            { name: 'surplus', type: 'uint128' },
            { name: 'balance', type: 'uint128' },
          ],
        },
        { name: 'timestamp', type: 'uint256' },
      ],
    },
  ],
}];
