// Outgoing requests to URLs someone else chose (OAuth client metadata documents, webhooks): only to public internet
// addresses, so the server can't be used to reach its own network, the cloud's metadata service or localhost (SSRF).
// Every address a name resolves to must be public (a mixed answer is how DNS rebinding sneaks an internal one in), and
// the connection is then pinned to the address that was checked, so the name is never resolved a second time.
import dns from 'node:dns';
import net from 'node:net';

const BLOCKED = (() => {
  const b = new net.BlockList();
  for (const [a, p] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    b.addSubnet(a, p, 'ipv4');
  for (const [a, p] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    b.addSubnet(a, p, 'ipv6');
  return b;
})();

/** True when `ip` is private, loopback, link-local, reserved or otherwise not a public internet address. */
export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 4) return BLOCKED.check(ip, 'ipv4');
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
  return BLOCKED.check(ip, 'ipv6');
}

export interface Address {
  address: string;
  family: number;
}
export type Resolver = (host: string) => Promise<Address[]>;

export const systemResolve: Resolver = async (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** A URL's host without IPv6 brackets. */
export const hostOf = (u: URL): string => u.hostname.replace(/^\[|\]$/g, '');

/**
 * The address to connect to for `host`, after checking that every address it resolves to is public; throws with a
 * reason otherwise. `blocked` is replaceable for tests that serve on loopback.
 */
export async function publicAddress(host: string, resolve: Resolver = systemResolve, blocked = isBlockedAddress): Promise<Address> {
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolve(host);
  if (!addrs.length) throw new Error(`${host} does not resolve`);
  if (addrs.some((a) => blocked(a.address))) throw new Error(`${host} is a private address`);
  return addrs[0] as Address;
}

/** For http(s).request: connect to the address already checked, never resolve the name again. */
export const pinnedLookup =
  (addr: Address) =>
  (_host: string, opts: { all?: boolean } | undefined, cb: (err: Error | null, a: string | Address[], family?: number) => void): void =>
    opts?.all ? cb(null, [addr]) : cb(null, addr.address, addr.family);
