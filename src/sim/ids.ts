// Random source for ids / IPs. Scenarios run under withStableIds() so the same lesson always
// produces the same ids (dialogue and tests can reference them), while user actions get random ones.
let rand: () => number = Math.random;

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function withStableIds<T>(seed: string, fn: () => T): T {
  const prev = rand;
  rand = mulberry32(hash(seed));
  try {
    return fn();
  } finally {
    rand = prev;
  }
}

/** n characters derived from `seed` (same seed, same string): for ids that must follow a name or another id */
export function stableChars(seed: string, chars: string, n: number): string {
  const r = mulberry32(hash(seed));
  return Array.from({ length: n }, () => chars[Math.floor(r() * chars.length)]).join('');
}

export function randomInt(maxExclusive: number): number {
  return Math.floor(rand() * maxExclusive);
}

function randomChars(chars: string, length: number): string {
  return Array.from({ length }, () => chars[randomInt(chars.length)]).join('');
}

/** AWS-style resource id, e.g. vpc-0f3a1b2c3d4e5f607. */
export function newId(prefix: string, length = 17): string {
  return `${prefix}-${randomChars('0123456789abcdef', length)}`;
}

export function randomHex(length: number): string {
  return randomChars('0123456789abcdef', length);
}

export function randomLowerAlnum(length: number): string {
  return randomChars('abcdefghijklmnopqrstuvwxyz0123456789', length);
}

export function randomDigits(length: number): string {
  return randomChars('0123456789', length);
}

/** random UUID v4 (event IDs, request IDs) */
export function newUuid(): string {
  const h = (n: number) => randomChars('0123456789abcdef', n);
  return `${h(8)}-${h(4)}-4${h(3)}-${'89ab'[randomInt(4)]}${h(3)}-${h(12)}`;
}
