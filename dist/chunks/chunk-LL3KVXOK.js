"use strict";Object.defineProperty(exports, "__esModule", {value: true});// src/platform/LilypadPlatform.ts
function runInBackground(platform, task, onError) {
  var _a;
  const handled = task.catch(onError);
  try {
    (_a = platform == null ? void 0 : platform.background) == null ? void 0 : _a.call(platform, handled);
  } catch (error) {
    onError(error);
  }
}
function runAfterResponse(platform, work, onError) {
  if (platform == null ? void 0 : platform.afterResponse) {
    try {
      platform.afterResponse(() => work().catch(onError));
      return;
    } catch (error) {
      onError(error);
    }
  }
  runInBackground(platform, work(), onError);
}
async function sharedStoreOperation(operation, fallback, timeout, onError) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Shared store did not answer within ${timeout}ms`)),
      timeout
    );
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
function toTtlSeconds(ms) {
  return Math.max(1, Math.ceil(ms / 1e3));
}






exports.runInBackground = runInBackground; exports.runAfterResponse = runAfterResponse; exports.sharedStoreOperation = sharedStoreOperation; exports.toTtlSeconds = toTtlSeconds;
//# sourceMappingURL=chunk-LL3KVXOK.js.map