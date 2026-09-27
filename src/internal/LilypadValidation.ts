/**
 * Checks of the numeric options (durations in milliseconds, sizes). A `NaN` or a negative value
 * would otherwise slip through the comparisons silently (e.g. `now - last < NaN` is always false).
 */

/**
 * The longest delay a timer accepts: beyond it, `setTimeout` and `setInterval` fire after 1 ms
 * (Node.js warns with a `TimeoutOverflowWarning`, browsers and edge runtimes stay silent).
 */
export const LILYPAD_MAX_TIMER_DELAY = 2_147_483_647;

type NumberRule =
  | 'positive'
  | 'non-negative'
  | 'positive-integer'
  | 'non-negative-integer'
  /** A positive delay given to a timer: at most {@link LILYPAD_MAX_TIMER_DELAY}. */
  | 'positive-delay'
  /** A non-negative delay given to a timer: at most {@link LILYPAD_MAX_TIMER_DELAY}. */
  | 'non-negative-delay';

const DESCRIPTIONS: Record<NumberRule, string> = {
  positive: 'a positive finite number',
  'non-negative': 'a non-negative finite number',
  'positive-integer': 'a positive integer',
  'non-negative-integer': 'a non-negative integer',
  'positive-delay': `a positive number of milliseconds, at most ${LILYPAD_MAX_TIMER_DELAY}`,
  'non-negative-delay': `a non-negative number of milliseconds, at most ${LILYPAD_MAX_TIMER_DELAY}`,
};

function satisfies(value: number, rule: NumberRule): boolean {
  switch (rule) {
    case 'positive':
      return Number.isFinite(value) && value > 0;
    case 'non-negative':
      return Number.isFinite(value) && value >= 0;
    case 'positive-integer':
      return Number.isInteger(value) && value > 0;
    case 'non-negative-integer':
      return Number.isInteger(value) && value >= 0;
    case 'positive-delay':
      return Number.isFinite(value) && value > 0 && value <= LILYPAD_MAX_TIMER_DELAY;
    case 'non-negative-delay':
      return Number.isFinite(value) && value >= 0 && value <= LILYPAD_MAX_TIMER_DELAY;
  }
}

/**
 * Throws if `value` is set and does not follow `rule`.
 *
 * @param owner - The class whose option it is, for the message.
 */
export function assertNumberOption(
  owner: string,
  name: string,
  value: number | undefined,
  rule: NumberRule
): void {
  if (value !== undefined && (typeof value !== 'number' || !satisfies(value, rule))) {
    throw new Error(`${owner}: ${name} must be ${DESCRIPTIONS[rule]} (got ${String(value)}).`);
  }
}
