/**
 * `@lilypad/libs/logger`: the logger and its components. Runs in Node.js and in edge runtimes.
 */
export { LilypadLogger } from '../logger/LilypadLogger';
export type { LilypadLoggerConstructorOptions, LilypadLoggerType } from '../logger/LilypadLogger';
export type { LilypadLibLogger, LilypadLibLogLevel } from '../logger/LilypadLibLogger';

export { LilypadLoggerComponent } from '../logger/LilypadLoggerComponent';
export type {
  LilypadLogRecord,
  LilypadLoggerComponentOptions,
} from '../logger/LilypadLoggerComponent';
export { LilypadConsoleLogger } from '../logger/components/ConsoleLogger';
export { LilypadJsonConsoleLogger } from '../logger/components/JsonConsoleLogger';
export { LilypadDiscordLogger } from '../logger/components/DiscordLogger';
export type { LilypadDiscordLoggerOptions } from '../logger/components/DiscordLogger';
