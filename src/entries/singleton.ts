/**
 * `@lilypad/libs/singleton`: the process-wide registry. Runs in Node.js and in edge runtimes.
 */
export {
  getLilypadSingletonInstance,
  getLilypadSingletonInstanceAsync,
  removeLilypadSingletonInstance,
} from '../singleton/LilypadSingleton';
export type {
  LilypadSingletonAble,
  LilypadSingletonSignature,
} from '../singleton/LilypadSingleton';
