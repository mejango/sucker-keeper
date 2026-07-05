// Pure helpers of the mesh layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupKeyOf, bytes32ToAddress } from '../src/mesh.js';

test('groupKeyOf picks the numerically smallest chainId member (not lexicographic)', () => {
  assert.equal(groupKeyOf([
    { chainId: 421614, projectId: '7' },
    { chainId: 84532, projectId: '1' }, // 84532 < 421614 numerically, > lexicographically
    { chainId: 11155111, projectId: '3' },
  ]), '84532:1');
  assert.equal(groupKeyOf([{ chainId: 1, projectId: '20' }, { chainId: 1, projectId: '3' }]), '1:3');
});

test('bytes32ToAddress takes the low 20 bytes', () => {
  assert.equal(
    bytes32ToAddress('0x000000000000000000000000AbCdEf0123456789abcdef0123456789ABCDEF01'),
    '0xabcdef0123456789abcdef0123456789abcdef01',
  );
});
