//#region src/cache/LilypadCacheTypes.ts
/**
* Thrown by `getOrSet` for a key whose last fetch failed less than `failureCooldown` ago, when no
* fallback value is available.
*/
var LilypadCacheCooldownError = class extends Error {
	constructor(key, cooldown) {
		super(`Fetching "${key}" failed less than ${cooldown}ms ago: not retrying yet.`);
		this.name = "LilypadCacheCooldownError";
	}
};
/** Thrown by the public methods of a cache (or a gate) once it is disposed (or closed). */
var LilypadDisposedError = class extends Error {
	/** @param subject - What is disposed, e.g. `LilypadCache "users"`. */
	constructor(subject, state = "disposed") {
		super(`${subject} is ${state}.`);
		this.name = "LilypadDisposedError";
	}
};
//#endregion
export { LilypadDisposedError as n, LilypadCacheCooldownError as t };

//# sourceMappingURL=LilypadCacheTypes-DuzvYfI8.mjs.map