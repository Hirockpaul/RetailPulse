import { hashPassword, verifyAgainstDummy, verifyPassword } from './password';

// scrypt is deliberately slow (~0.1-0.3 s per hash, more on a busy machine); give it room
// instead of weakening the parameters.
jest.setTimeout(30_000);

describe('password hashing (scrypt)', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('never stores the password and uses a fresh salt each time', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toContain('same-password-123');
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it.each(['', 'plaintext', 'bcrypt$10$abc$def', 'scrypt$x$y$z$AAAA$BBBB', 'scrypt$1$1$1$$'])(
    'treats malformed hash %p as a failed check, not an error',
    async (stored) => {
      expect(await verifyPassword('anything', stored)).toBe(false);
    },
  );

  it('dummy verification always fails', async () => {
    expect(await verifyAgainstDummy('anything')).toBe(false);
  });
});
