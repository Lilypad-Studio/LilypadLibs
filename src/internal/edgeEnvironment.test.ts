import { describe, it, expect } from 'vitest';

const inEdgeProject = typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime === 'string';

// The `edge` project runs the tests of the edge modules without the Node.js globals
// (vitest.edge-setup.ts), so that a module relying on one fails there
describe.runIf(inEdgeProject)('edge test environment', () => {
  it.each(['process', 'Buffer', 'global', 'setImmediate', 'clearImmediate'])(
    'should not define the Node.js global "%s"',
    (name) => {
      expect(typeof (globalThis as Record<string, unknown>)[name]).toBe('undefined');
    }
  );

  it('should keep the web APIs of the edge runtimes', () => {
    expect(typeof globalThis.crypto.randomUUID).toBe('function');
    expect(typeof globalThis.setTimeout).toBe('function');
    expect(typeof globalThis.structuredClone).toBe('function');
  });
});
