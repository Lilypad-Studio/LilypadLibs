"use strict";Object.defineProperty(exports, "__esModule", {value: true});// src/singleton/LilypadSingleton.ts
var singletonMap = globalThis.__lilypadSingletonMap ??= /* @__PURE__ */ new Map();
var signatureMap = globalThis.__lilypadSingletonSignatureMap ??= /* @__PURE__ */ new Map();
function checkSignature(identifier, signature) {
  if (!signature) {
    return;
  }
  const stored = signatureMap.get(identifier);
  if (stored === void 0) {
    signatureMap.set(identifier, signature.value);
  } else if (stored !== signature.value) {
    signature.onMismatch();
  }
}
function getLilypadSingletonInstance(identifier, createInstanceFn, signature) {
  if (singletonMap.has(identifier)) {
    const existing = singletonMap.get(identifier);
    if (existing instanceof Promise) {
      throw new Error(
        `Singleton "${identifier}" is being created asynchronously: use getLilypadSingletonInstanceAsync.`
      );
    }
    checkSignature(identifier, signature);
    return existing;
  }
  const instance = createInstanceFn();
  singletonMap.set(identifier, instance);
  signatureMap.delete(identifier);
  checkSignature(identifier, signature);
  return instance;
}
function removeLilypadSingletonInstance(identifier) {
  signatureMap.delete(identifier);
  return singletonMap.delete(identifier);
}
async function getLilypadSingletonInstanceAsync(identifier, createInstanceFn, signature) {
  if (singletonMap.has(identifier)) {
    checkSignature(identifier, signature);
    return singletonMap.get(identifier);
  }
  const instancePromise = createInstanceFn();
  singletonMap.set(identifier, instancePromise);
  signatureMap.delete(identifier);
  checkSignature(identifier, signature);
  try {
    const instance = await instancePromise;
    if (singletonMap.get(identifier) === instancePromise) {
      singletonMap.set(identifier, instance);
    }
    return instance;
  } catch (error) {
    if (singletonMap.get(identifier) === instancePromise) {
      removeLilypadSingletonInstance(identifier);
    }
    throw error;
  }
}
function createLilypadSingletonAbleAsync(namespace, options, createInstanceFn, signature) {
  if (!options.singleton) {
    return createInstanceFn(void 0);
  }
  const registryKey = `${namespace}:${options.singletonIdentifier}`;
  return getLilypadSingletonInstanceAsync(
    registryKey,
    () => createInstanceFn(registryKey),
    signature
  );
}






exports.getLilypadSingletonInstance = getLilypadSingletonInstance; exports.removeLilypadSingletonInstance = removeLilypadSingletonInstance; exports.getLilypadSingletonInstanceAsync = getLilypadSingletonInstanceAsync; exports.createLilypadSingletonAbleAsync = createLilypadSingletonAbleAsync;
//# sourceMappingURL=chunk-GU4ZU4ST.js.map