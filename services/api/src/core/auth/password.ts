import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node, no native dependency).
 * Parameters follow OWASP's scrypt guidance (N=2^15, r=8, p=3 ≈ 32 MiB, ~100 ms).
 * Stored format: scrypt$N$r$p$salt(base64)$hash(base64) — parameters travel with each hash,
 * so they can be raised later without breaking existing passwords.
 * scripts/seed.mjs creates demo hashes in the same format.
 */
const N = 32768;
const R = 8;
const P = 3;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

export const MAX_PASSWORD_LENGTH = 200;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time comparison. Malformed or unsupported hashes simply fail. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  try {
    const actual = await derive(
      password,
      Buffer.from(salt, 'base64'),
      Number(n),
      Number(r),
      Number(p),
      expected.length,
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same CPU time as a real check when the account does not exist, so response time
 * does not reveal which emails are registered.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummyHash);
  return false;
}
