// Setup of the `edge` vitest project. The `edge-runtime` environment adds the globals of an edge
// runtime but leaves those of Node.js: this removes them, so that an edge module that relies on
// one fails its tests. They come back once the tests of the file are done: the teardown of the
// vitest worker reads the global `process`

import { afterAll } from 'vitest';

const nodeGlobals: readonly string[] = [
  'process',
  'Buffer',
  'global',
  'setImmediate',
  'clearImmediate',
];

const removed = new Map<string, PropertyDescriptor>();

for (const name of nodeGlobals) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor) {
    removed.set(name, descriptor);
  }
  Reflect.deleteProperty(globalThis, name);
}

afterAll(() => {
  for (const [name, descriptor] of removed) {
    Object.defineProperty(globalThis, name, descriptor);
  }
});
