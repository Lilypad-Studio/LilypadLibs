//#region src/internal/LilypadTimeout.ts
/**
* Runs `operation` and rejects with `createError()` if it has not settled within `timeout` ms; the
* signal it receives is aborted with that error. JavaScript cannot stop a running promise:
* `operation` should observe the signal. The timer is always cleared.
*/
async function withLilypadTimeout(operation, timeout, createError) {
	const controller = new AbortController();
	let timer;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = createError();
			controller.abort(error);
			reject(error);
		}, timeout);
	});
	try {
		return await Promise.race([operation(controller.signal), timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}
//#endregion
export { withLilypadTimeout as t };

//# sourceMappingURL=LilypadTimeout-Cn18ZBz-.mjs.map