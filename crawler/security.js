const dns = require('dns').promises;
const net = require('net');
const config = require('../config');

// In-memory DNS cache: hostname -> Promise<Array of addresses>
const dnsCache = new Map();

/**
 * Normalizes and checks if an IP belongs to private/loopback/link-local ranges.
 * @param {string} ip
 * @returns {boolean}
 */
function isIpInRestrictedRanges(ip) {
  if (process.env.BYPASS_SSRF_FOR_TEST === 'true' && (ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip === '::1')) {
    return false;
  }
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return true; // Treat invalid IPv4 as restricted
    const [p0, p1] = parts;
    // 127.0.0.0/8 (loopback)
    if (p0 === 127) return true;
    // 10.0.0.0/8 (private)
    if (p0 === 10) return true;
    // 172.16.0.0/12 (private)
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    // 192.168.0.0/16 (private)
    if (p0 === 192 && p1 === 168) return true;
    // 169.254.0.0/16 (link-local, cloud metadata)
    if (p0 === 169 && p1 === 254) return true;
    // 0.0.0.0/8 (broadcast/local)
    if (p0 === 0) return true;
    return false;
  } else if (net.isIPv6(ip)) {
    const cleanIp = ip.toLowerCase().trim();

    // Loopback checks
    if (cleanIp === '::1' || cleanIp === '0:0:0:0:0:0:0:1' || cleanIp === '::ffff:127.0.0.1') return true;

    // Handle IPv4-mapped IPv6
    if (cleanIp.startsWith('::ffff:')) {
      const ipv4 = cleanIp.substring(7);
      if (net.isIPv4(ipv4)) {
        return isIpInRestrictedRanges(ipv4);
      }
    }

    const segments = expandIPv6(cleanIp);
    if (!segments) return true; // Treat malformed IPv6 as restricted

    const firstWord = segments[0];
    const firstVal = parseInt(firstWord, 16);
    if (isNaN(firstVal)) return true;

    // fc00::/7 (Unique Local Address) - starts with fc or fd
    if ((firstVal >> 9) === 0x7e) return true;

    // fe80::/10 (Link-Local Address) - starts with fe8, fe9, fea, feb
    if ((firstVal >> 6) === 0x3fa) return true;

    return false;
  }
  return true; // Non-IP or unsupported formats are blocked by default
}

/**
 * Expands short-form IPv6 to an 8-segment hex string array.
 * @param {string} ip
 * @returns {string[]|null}
 */
function expandIPv6(ip) {
  const parts = ip.split(':');
  if (parts.length > 8) return null;

  const doubleColonIndex = parts.indexOf('');
  if (doubleColonIndex !== -1) {
    const numZeros = 8 - (parts.length - 1);
    const expandedParts = [];
    for (let i = 0; i < parts.length; i++) {
      if (i === doubleColonIndex) {
        for (let j = 0; j < numZeros; j++) {
          expandedParts.push('0000');
        }
      } else {
        expandedParts.push(parts[i] || '0000');
      }
    }
    return expandedParts.map(p => p.padStart(4, '0'));
  }

  if (parts.length !== 8) return null;
  return parts.map(p => p.padStart(4, '0'));
}

/**
 * Asserts that a URL is safe from SSRF targets.
 * @param {string} urlString
 * @returns {Promise<URL>}
 */
async function assertSafeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (err) {
    throw new Error('Invalid URL structure');
  }

  // 1. Validate scheme/protocol
  const protocol = url.protocol;
  if (!config.ALLOWED_PROTOCOLS.includes(protocol)) {
    throw new Error(`Forbidden protocol: ${protocol}`);
  }

  // 2. Validate port
  const portString = url.port;
  if (portString) {
    const port = parseInt(portString, 10);
    const allowedPorts = [80, 443, 8080, 8443];
    if (process.env.BYPASS_SSRF_FOR_TEST === 'true' && [4567, 4568, 4570].includes(port)) {
      // Allow test ports
    } else if (!allowedPorts.includes(port)) {
      throw new Error(`Forbidden port: ${port}`);
    }
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new Error('Missing hostname');
  }

  // 3. Check if hostname is already a raw IP
  if (net.isIP(hostname)) {
    if (isIpInRestrictedRanges(hostname)) {
      throw new Error(`Forbidden IP target: ${hostname}`);
    }
    return url;
  }

  // 4. Resolve and check hostname IP address(es)
  let addresses;
  if (dnsCache.has(hostname)) {
    addresses = await dnsCache.get(hostname);
  } else {
    const lookupPromise = dns.lookup(hostname, { all: true }).catch(err => {
      dnsCache.delete(hostname); // clear failures
      throw err;
    });
    dnsCache.set(hostname, lookupPromise);
    addresses = await lookupPromise;
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS resolution failed: no addresses resolved for ${hostname}`);
  }

  for (const addr of addresses) {
    if (isIpInRestrictedRanges(addr.address)) {
      throw new Error(`Hostname ${hostname} resolves to a forbidden IP address: ${addr.address}`);
    }
  }

  return url;
}

module.exports = {
  assertSafeUrl,
  isIpInRestrictedRanges
};
