const assert = require('assert');
const { assertSafeUrl, isIpInRestrictedRanges } = require('../crawler/security');

async function runTests() {
  console.log('Starting SSRF Guard Unit Tests...');

  // Test 1: Check restricted IPv4 ranges
  assert.strictEqual(isIpInRestrictedRanges('127.0.0.1'), true, '127.0.0.1 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('10.0.0.1'), true, '10.0.0.1 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('172.16.0.1'), true, '172.16.0.1 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('172.31.255.255'), true, '172.31.255.255 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('172.32.0.1'), false, '172.32.0.1 should be public (safe)');
  assert.strictEqual(isIpInRestrictedRanges('192.168.1.100'), true, '192.168.1.100 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('169.254.169.254'), true, '169.254.169.254 (metadata) should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('8.8.8.8'), false, '8.8.8.8 should be public (safe)');

  // Test 2: Check restricted IPv6 ranges
  assert.strictEqual(isIpInRestrictedRanges('::1'), true, '::1 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('0:0:0:0:0:0:0:1'), true, 'Expanded ::1 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('fc00::1'), true, 'fc00::1 (ULA) should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), true, 'fdff... (ULA) should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('fe80::1'), true, 'fe80::1 (Link-local) should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('febf::ffff'), true, 'febf::ffff (Link-local) should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('2001:db8::'), false, '2001:db8:: should be public (safe)');
  assert.strictEqual(isIpInRestrictedRanges('::ffff:127.0.0.1'), true, 'IPv4-mapped 127.0.0.1 should be restricted');
  assert.strictEqual(isIpInRestrictedRanges('::ffff:8.8.8.8'), false, 'IPv4-mapped 8.8.8.8 should be public (safe)');

  // Test 3: URL assertions
  // Safe URLs
  await assert.doesNotReject(() => assertSafeUrl('https://example.com'), 'example.com should be safe');
  await assert.doesNotReject(() => assertSafeUrl('http://8.8.8.8'), 'http://8.8.8.8 should be safe');
  await assert.doesNotReject(() => assertSafeUrl('https://example.com:8443/test'), 'port 8443 should be allowed');

  // Unsafe URLs
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1'), /Forbidden IP target/, '127.0.0.1 should be rejected');
  await assert.rejects(() => assertSafeUrl('http://localhost'), /Resolves to a forbidden IP/i, 'localhost should resolve to private IP and be rejected');
  await assert.rejects(() => assertSafeUrl('ftp://example.com'), /Forbidden protocol/, 'ftp:// protocol should be rejected');
  await assert.rejects(() => assertSafeUrl('https://example.com:3000'), /Forbidden port/, 'port 3000 should be rejected');

  console.log('All SSRF Guard tests completed successfully!');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
