"use strict";
const require_LilypadValidation = require("./LilypadValidation-BobS4Y-i.cjs");
//#region src/platform/LilypadPlatform.ts
/**
* Runs `task` without awaiting it: its errors go to `onError` (they never become unhandled
* rejections), and the platform keeps the instance alive until it settles.
*
* @param onPlatformError - Receives the error of `platform.background` itself (e.g. `after` called
* outside a request scope), which is not an error of the task: the task still runs, without the
* guarantee. Defaults to ignoring it.
*/
function runInBackground(platform, task, onError, onPlatformError = () => {}) {
	const handled = task.catch(onError);
	try {
		platform?.background?.(handled);
	} catch (error) {
		onPlatformError(error);
	}
}
/**
* Runs `work` after the response when the platform supports it, otherwise at once as background
* work. Its errors go to `onError`.
*
* @param onPlatformError - Receives the error of `platform.afterResponse` or `platform.background`
* itself: the work then starts at once. Defaults to ignoring it.
*/
function runAfterResponse(platform, work, onError, onPlatformError = () => {}) {
	if (platform?.afterResponse) try {
		platform.afterResponse(() => work().catch(onError));
		return;
	} catch (error) {
		onPlatformError(error);
	}
	runInBackground(platform, work(), onError, onPlatformError);
}
/**
* Runs `operation` on the shared store, bounded by `timeout`. A failure or a timeout resolves to
* `fallback` after calling `onError`: the shared store is never required to answer.
*/
async function sharedStoreOperation(operation, fallback, timeout, onError) {
	try {
		return await require_LilypadValidation.withLilypadTimeout(() => operation(), timeout, () => /* @__PURE__ */ new Error(`Shared store did not answer within ${timeout}ms`));
	} catch (error) {
		onError(error);
		return fallback;
	}
}
/** Converts milliseconds to the whole seconds used by the shared store TTLs (at least 1). */
function toTtlSeconds(ms) {
	return Math.max(1, Math.ceil(ms / 1e3));
}
//#endregion
Object.defineProperty(exports, "runAfterResponse", {
	enumerable: true,
	get: function() {
		return runAfterResponse;
	}
});
Object.defineProperty(exports, "runInBackground", {
	enumerable: true,
	get: function() {
		return runInBackground;
	}
});
Object.defineProperty(exports, "sharedStoreOperation", {
	enumerable: true,
	get: function() {
		return sharedStoreOperation;
	}
});
Object.defineProperty(exports, "toTtlSeconds", {
	enumerable: true,
	get: function() {
		return toTtlSeconds;
	}
});

//# sourceMappingURL=LilypadPlatform-B4n37kmx.cjs.map