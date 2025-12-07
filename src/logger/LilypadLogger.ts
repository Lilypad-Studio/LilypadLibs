export abstract class LilypadLogger {
  abstract log(message: string): void;
  abstract error(message: string): void;
  abstract warn(message: string): void;
}
