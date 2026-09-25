/**
 * `@lilypad/libs/platform`: the types that connect the library to the hosting platform
 * (background work, shared cache level, invalidation hooks). Runs in Node.js and in edge runtimes.
 */
export type {
  LilypadBackground,
  LilypadInvalidationEvent,
  LilypadPlatform,
  LilypadSharedStore,
} from '../platform/LilypadPlatform';
