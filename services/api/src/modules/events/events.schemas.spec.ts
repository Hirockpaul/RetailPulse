import { ConsumerRegistry } from './consumer-registry';
import { MAX_ATTEMPTS, retryDelaySeconds } from './events.schemas';

describe('retry policy', () => {
  it('gives up after three attempts and backs off between them', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect([1, 2].map(retryDelaySeconds)).toEqual([2, 4]);
  });
});

describe('ConsumerRegistry', () => {
  const consumer = (name: string, ...eventTypes: string[]) => ({
    name,
    eventTypes,
    handle: async () => undefined,
  });

  it('finds consumers by event type', () => {
    const registry = new ConsumerRegistry();
    registry.register(consumer('a', 'x', 'y'));
    registry.register(consumer('b', 'y'));
    expect(registry.forType('x').map((c) => c.name)).toEqual(['a']);
    expect(registry.forType('y').map((c) => c.name)).toEqual(['a', 'b']);
    expect(registry.forType('z')).toEqual([]);
  });

  it('refuses two consumers with the same name, and can unregister', () => {
    const registry = new ConsumerRegistry();
    registry.register(consumer('a', 'x'));
    expect(() => registry.register(consumer('a', 'x'))).toThrow(/already registered/);
    registry.unregister('a');
    registry.register(consumer('a', 'x'));
  });
});
