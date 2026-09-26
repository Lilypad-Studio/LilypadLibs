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
function registryKeyOf(namespace, options) {
  return options.singleton ? `${namespace}:${options.singletonIdentifier}` : void 0;
}
function releaseFor(registryKey) {
  let released = registryKey === void 0;
  return () => {
    if (!released) {
      released = true;
      removeLilypadSingletonInstance(registryKey);
    }
  };
}
function createLilypadSingletonAble(namespace, options, createInstanceFn, signature) {
  const registryKey = registryKeyOf(namespace, options);
  if (registryKey === void 0) {
    return createInstanceFn(releaseFor(void 0));
  }
  return getLilypadSingletonInstance(
    registryKey,
    () => createInstanceFn(releaseFor(registryKey)),
    signature
  );
}
function createLilypadSingletonAbleAsync(namespace, options, createInstanceFn, signature) {
  const registryKey = registryKeyOf(namespace, options);
  if (registryKey === void 0) {
    return createInstanceFn(releaseFor(void 0));
  }
  return getLilypadSingletonInstanceAsync(
    registryKey,
    () => createInstanceFn(releaseFor(registryKey)),
    signature
  );
}







exports.getLilypadSingletonInstance = getLilypadSingletonInstance; exports.removeLilypadSingletonInstance = removeLilypadSingletonInstance; exports.getLilypadSingletonInstanceAsync = getLilypadSingletonInstanceAsync; exports.createLilypadSingletonAble = createLilypadSingletonAble; exports.createLilypadSingletonAbleAsync = createLilypadSingletonAbleAsync;
//# sourceMappingURL=chunk-BQAYFDD3.js.map