"use strict";
//#region src/platform/LilypadPlatform.ts
/**
* Runs `task` without awaiting it: its errors go to `onError` (they never become unhandled
* rejections), and the platform keeps the instance alive until it settles.
*/
function runInBackground(platform, task, onError) {
	const handled = task.catch(onError);
	try {
		platform?.background?.(handled);
	} catch (error) {
		onError(error);
	}
}
/**
* Runs `work` after the response when the platform supports it, otherwise at once as background
* work. Its errors go to `onError`.
*/
function runAfterResponse(platform, work, onError) {
	if (platform?.afterResponse) try {
		platform.afterResponse(() => work().catch(onError));
		return;
	} catch (error) {
		onError(error);
	}
	runInBackground(platform, work(), onError);
}
/**
* Runs `operation` on the shared store, bounded by `timeout`. A failure or a timeout resolves to
* `fallback` after calling `onError`: the shared store is never required to answer.
*/
async function sharedStoreOperation(operation, fallback, timeout, onError) {
	let timer;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`Shared store did not answer within ${timeout}ms`)), timeout);
	});
	try {
		return await Promise.race([operation(), timeoutPromise]);
	} catch (error) {
		onError(error);
		return fallback;
	} finally {
		clearTimeout(timer);
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

//# sourceMappingURL=LilypadPlatform-jQx1ySi1.cjs.map