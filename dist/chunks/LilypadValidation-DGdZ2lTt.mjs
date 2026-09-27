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
//#region src/internal/LilypadValidation.ts
/**
* Checks of the numeric options (durations in milliseconds, sizes). A `NaN` or a negative value
* would otherwise slip through the comparisons silently (e.g. `now - last < NaN` is always false).
*/
/**
* The longest delay a timer accepts: beyond it, `setTimeout` and `setInterval` fire after 1 ms
* (Node.js warns with a `TimeoutOverflowWarning`, browsers and edge runtimes stay silent).
*/
const LILYPAD_MAX_TIMER_DELAY = 2147483647;
const DESCRIPTIONS = {
	positive: "a positive finite number",
	"non-negative": "a non-negative finite number",
	"positive-integer": "a positive integer",
	"non-negative-integer": "a non-negative integer",
	"positive-delay": `a positive number of milliseconds, at most ${LILYPAD_MAX_TIMER_DELAY}`,
	"non-negative-delay": `a non-negative number of milliseconds, at most ${LILYPAD_MAX_TIMER_DELAY}`
};
function satisfies(value, rule) {
	switch (rule) {
		case "positive": return Number.isFinite(value) && value > 0;
		case "non-negative": return Number.isFinite(value) && value >= 0;
		case "positive-integer": return Number.isInteger(value) && value > 0;
		case "non-negative-integer": return Number.isInteger(value) && value >= 0;
		case "positive-delay": return Number.isFinite(value) && value > 0 && value <= 2147483647;
		case "non-negative-delay": return Number.isFinite(value) && value >= 0 && value <= 2147483647;
	}
}
/**
* Throws if `value` is set and does not follow `rule`.
*
* @param owner - The class whose option it is, for the message.
*/
function assertNumberOption(owner, name, value, rule) {
	if (value !== void 0 && (typeof value !== "number" || !satisfies(value, rule))) throw new Error(`${owner}: ${name} must be ${DESCRIPTIONS[rule]} (got ${String(value)}).`);
}
//#endregion
export { withLilypadTimeout as n, assertNumberOption as t };

//# sourceMappingURL=LilypadValidation-DGdZ2lTt.mjs.map