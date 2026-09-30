import ipaddr from 'ipaddr.js';

/** Strict IPv4 CIDR: four-part decimal, prefix 0-32, and the address must be the network address (AWS rejects host bits). */
export function isValidCidr(cidr: string): boolean {
  if (!ipaddr.IPv4.isValidCIDRFourPartDecimal(cidr)) return false;
  return ipaddr.IPv4.networkAddressFromCIDR(cidr).toString() === cidr.split('/')[0];
}

export function isValidIp(ip: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(ip);
}

export function prefixLength(cidr: string): number {
  return Number(cidr.split('/')[1]);
}

function toInt(ip: string): number {
  return ipaddr.IPv4.parse(ip).toByteArray().reduce((n, b) => n * 256 + b, 0);
}

function fromInt(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
}

/** [first, last] address of the block as integers. */
function range(cidr: string): [number, number] {
  const [ip, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(toInt(ip) / size) * size;
  return [start, start + size - 1];
}

export function cidrSize(cidr: string): number {
  return 2 ** (32 - prefixLength(cidr));
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [s, e] = range(cidr);
  const n = toInt(ip);
  return n >= s && n <= e;
}

/** outer fully contains inner (Subnet belongs to VPC). */
export function cidrContains(outer: string, inner: string): boolean {
  const [os, oe] = range(outer);
  const [is, ie] = range(inner);
  return is >= os && ie <= oe;
}

export function cidrOverlaps(a: string, b: string): boolean {
  const [as, ae] = range(a);
  const [bs, be] = range(b);
  return as <= be && bs <= ae;
}

/** n-th address inside the block (0 = network address). */
export function nthIp(cidr: string, n: number): string {
  return fromInt(range(cidr)[0] + n);
}

export function ipOffset(cidr: string, ip: string): number {
  return toInt(ip) - range(cidr)[0];
}

/** AWS reserves the first four and the last address of every subnet. */
export const RESERVED_IPS_PER_SUBNET = 5;
