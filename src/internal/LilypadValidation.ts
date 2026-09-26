/**
 * Checks of the numeric options (durations in milliseconds, sizes). A `NaN` or a negative value
 * would otherwise slip through the comparisons silently (e.g. `now - last < NaN` is always false).
 */

type NumberRule = 'positive' | 'non-negative' | 'positive-integer' | 'non-negative-integer';

const DESCRIPTIONS: Record<NumberRule, string> = {
  positive: 'a positive finite number',
  'non-negative': 'a non-negative finite number',
  'positive-integer': 'a positive integer',
  'non-negative-integer': 'a non-negative integer',
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
