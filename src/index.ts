/**
 * LilypadLibs Main Export File
 * @packageDocumentation
 * @module LilypadLibs
 * @preferred
 * @author Lilypad Studios
 */

/**
 * Cache Module
 */
export { default as LilypadCache } from './cache/LilypadCache';
export type { LilypadCacheGetOptions, LilypadCachedValueType } from './cache/LilypadCache';

export { default as LilypadDbCache } from './cache/LilypadDbCache';
export type {
  LilypadDbCacheDefaultNotificationPayload,
  LilypadDbCacheDefaultListenerOptions,
} from './cache/LilypadDbCache';

/**
 * Database Gateway Module
 */
export { LilypadDbGate } from './dbGate/LilypadDbGate';
export type {
  LilypadDbGateOptions,
  LilypadDbSchema,
  LilypadDbColumnType,
  ListenerCallbackIdentifier,
} from './dbGate/LilypadDbGate';

/**
 * Logger Module
 */
export { default as createLogger, LilypadLogger } from './logger/LilypadLogger';
export type { LilypadLoggerConstructorOptions, LilypadLoggerType } from './logger/LilypadLogger';

/**
 * Logger Components: base class for custom components, and default components
 */
export { default as LilypadLoggerComponent } from './logger/LilypadLoggerComponent';
export { default as LilypadConsoleLogger } from './logger/components/ConsoleLogger';
export { default as LilypadDiscordLogger } from './logger/components/DiscordLogger';

/**
 * Flow Control Module
 */
export { LilypadFlowControl } from './flow/LilypadFlowControl';
export type { FlowControlOptions, ExecuteFnOptions } from './flow/LilypadFlowControl';

/**
 * Serializer Module
 */
export { LilypadSerializer } from './serializer/LilypadSerializer';
export type { LilypadSerializerConstructorOptions } from './serializer/LilypadSerializer';

/**
 * Singleton Module
 */
export {
  getLilypadSingletonInstance,
  getLilypadSingletonInstanceAsync,
  removeLilypadSingletonInstance,
} from './singleton/LilypadSingleton';
export type { LilypadSingletonAble } from './singleton/LilypadSingleton';
