/** Thrown by the public methods of a cache (or a gate) once it is disposed (or closed). */
export class LilypadDisposedError extends Error {
  /** @param subject - What is disposed, e.g. `LilypadCache "users"`. */
  constructor(subject: string, state: 'disposed' | 'closed' = 'disposed') {
    super(`${subject} is ${state}.`);
    this.name = 'LilypadDisposedError';
  }
}
