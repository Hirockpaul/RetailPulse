import { LoginThrottle } from './login-throttle';

describe('LoginThrottle', () => {
  let now = 1_000_000;
  const throttle = () => new LoginThrottle(3, 60_000, () => now);
  beforeEach(() => {
    now = 1_000_000;
  });

  it('allows attempts until the failure limit is reached', () => {
    const t = throttle();
    for (let i = 0; i < 3; i++) {
      expect(t.retryAfterSeconds('a|ip')).toBe(0);
      t.recordFailure('a|ip');
    }
    expect(t.retryAfterSeconds('a|ip')).toBe(60);
  });

  it('counts down and frees the key when the window ends', () => {
    const t = throttle();
    for (let i = 0; i < 3; i++) t.recordFailure('a|ip');
    now += 45_000;
    expect(t.retryAfterSeconds('a|ip')).toBe(15);
    now += 15_000;
    expect(t.retryAfterSeconds('a|ip')).toBe(0);
    t.recordFailure('a|ip'); // fresh window
    expect(t.retryAfterSeconds('a|ip')).toBe(0);
  });

  it('tracks keys independently and reset() clears one', () => {
    const t = throttle();
    for (let i = 0; i < 3; i++) t.recordFailure('a|ip');
    expect(t.retryAfterSeconds('b|ip')).toBe(0);
    t.reset('a|ip');
    expect(t.retryAfterSeconds('a|ip')).toBe(0);
  });
});
