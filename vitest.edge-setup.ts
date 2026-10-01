// Setup of the `edge` vitest project. The `edge-runtime` environment adds the globals of an edge
// runtime but leaves those of Node.js: this removes them, so that an edge module that relies on
// one fails its tests. Vitest itself keeps working: its worker captured what it needs at startup

const nodeGlobals: readonly string[] = [
  'process',
  'Buffer',
  'global',
  'setImmediate',
  'clearImmediate',
];

for (const name of nodeGlobals) {
  Reflect.deleteProperty(globalThis, name);
}

// A module, not a script: its names stay out of the global scope
export {};
