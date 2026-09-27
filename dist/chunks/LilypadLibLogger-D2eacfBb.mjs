//#region src/logger/LilypadLibLogger.ts
/**
* Logs a message on a level of a library logger. It never throws, and ignores the rejection of a
* returned promise: a failing logger must not break the module that logs, nor terminate the
* Node.js process with an unhandled rejection.
*
* @param source - The instance that logs (see {@link LilypadLogMeta.source}).
* @param detail - The value the message is about: an `Error` goes to `meta.error`, anything else to
* `meta.detail`.
*/
function libLog(logger, level, source, message, detail) {
	const method = logger?.[level];
	if (!method) return;
	const meta = detail === void 0 ? { source } : detail instanceof Error ? {
		source,
		error: detail
	} : {
		source,
		detail
	};
	try {
		const result = method.call(logger, message, meta);
		if (typeof result?.then === "function") Promise.resolve(result).catch(() => {});
	} catch {}
}
/**
* Adapts a pino logger (or any logger that takes the fields first) to {@link LilypadLibLogger}: the
* meta becomes the fields, with the error under `err`, so that pino serializes its stack.
*
* @example
* ```typescript
* const cache = new LilypadCache({ logger: lilypadPinoLogger(pino()) });
* ```
*/
function lilypadPinoLogger(pino) {
	const logger = {};
	for (const level of [
		"error",
		"warn",
		"info",
		"debug"
	]) {
		const method = pino[level];
		if (method) logger[level] = (message, { source, error, detail }) => method.call(pino, {
			source,
			err: error,
			detail
		}, message);
	}
	return logger;
}
//#endregion
export { lilypadPinoLogger as n, libLog as t };

//# sourceMappingURL=LilypadLibLogger-D2eacfBb.mjs.map