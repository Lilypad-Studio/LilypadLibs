//#region src/singleton/LilypadSingleton.ts
const singletonMap = globalThis.__lilypadSingletonMap ??= /* @__PURE__ */ new Map();
const signatureMap = globalThis.__lilypadSingletonSignatureMap ??= /* @__PURE__ */ new Map();
function checkSignature(identifier, signature) {
	if (!signature) return;
	const stored = signatureMap.get(identifier);
	if (stored === void 0) signatureMap.set(identifier, signature.value);
	else if (stored !== signature.value) signature.onMismatch();
}
function getLilypadSingletonInstance(identifier, createInstanceFn, signature) {
	if (singletonMap.has(identifier)) {
		const existing = singletonMap.get(identifier);
		if (existing instanceof Promise) throw new Error(`Singleton "${identifier}" is being created asynchronously: use getLilypadSingletonInstanceAsync.`);
		checkSignature(identifier, signature);
		return existing;
	}
	const instance = createInstanceFn();
	singletonMap.set(identifier, instance);
	signatureMap.delete(identifier);
	checkSignature(identifier, signature);
	return instance;
}
/**
* Removes a singleton instance from the registry, so that the next `create` call with the same
* identifier builds a fresh instance. Meant to be called when the instance is closed/disposed.
*
* @returns `true` if an instance was registered under the identifier.
*/
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
		if (singletonMap.get(identifier) === instancePromise) singletonMap.set(identifier, instance);
		return instance;
	} catch (error) {
		if (singletonMap.get(identifier) === instancePromise) removeLilypadSingletonInstance(identifier);
		throw error;
	}
}
function registryKeyOf(namespace, options) {
	return options.singleton ? `${namespace}:${options.singletonIdentifier}` : void 0;
}
/**
* The release function of an instance: it removes the registry entry only if it still holds that
* instance, not one registered under the same key since (e.g. after a manual removal).
*/
function releaseFor(registryKey, owner) {
	let released = registryKey === void 0;
	return () => {
		if (released) return;
		released = true;
		const current = singletonMap.get(registryKey);
		if (current !== void 0 && (current === owner.instance || current === owner.registered)) removeLilypadSingletonInstance(registryKey);
	};
}
/**
* Shared implementation of the synchronous `create` methods: builds a new instance, or returns the
* singleton registered under `namespace:singletonIdentifier`.
*
* @param createInstanceFn - Receives the function that removes the instance from the registry.
*/
function createLilypadSingletonAble(namespace, options, createInstanceFn, signature) {
	const registryKey = registryKeyOf(namespace, options);
	if (registryKey === void 0) return createInstanceFn(releaseFor(void 0, {}));
	const owner = {};
	return getLilypadSingletonInstance(registryKey, () => {
		const instance = createInstanceFn(releaseFor(registryKey, owner));
		owner.instance = instance;
		return instance;
	}, signature);
}
/**
* Shared implementation of the async `create` methods: builds a new instance, or returns the
* singleton registered under `namespace:singletonIdentifier`.
*
* @param createInstanceFn - Receives the function that removes the instance from the registry.
*/
function createLilypadSingletonAbleAsync(namespace, options, createInstanceFn, signature) {
	const registryKey = registryKeyOf(namespace, options);
	if (registryKey === void 0) return createInstanceFn(releaseFor(void 0, {}));
	const owner = {};
	return getLilypadSingletonInstanceAsync(registryKey, () => {
		const registered = createInstanceFn(releaseFor(registryKey, owner)).then((instance) => {
			owner.instance = instance;
			return instance;
		});
		owner.registered = registered;
		return registered;
	}, signature);
}
//#endregion
export { removeLilypadSingletonInstance as a, getLilypadSingletonInstanceAsync as i, createLilypadSingletonAbleAsync as n, getLilypadSingletonInstance as r, createLilypadSingletonAble as t };

//# sourceMappingURL=LilypadSingleton-w0oZfBDG.mjs.map