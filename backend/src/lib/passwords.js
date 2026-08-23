import { z } from 'zod';

/*
 * What counts as an acceptable password.
 *
 * Length alone was the only rule, so "aaaaaaaaaa" and "Password12" both passed. Neither
 * survives a dictionary run, and on a system holding payroll, bank details and contract
 * evidence that is the whole account. The tests below are the ones that actually shift the
 * odds: enough length, more than one kind of character, and not one of the handful of
 * passwords that appear at the top of every breach list.
 *
 * No maximum, no forced expiry and no composition beyond this — those push people towards
 * writing passwords down, which is a worse outcome than the one they prevent.
 */

const MIN_LENGTH = 12;

/* Not a dictionary — the shapes people reach for first, and the ones tied to this product. */
const TOO_COMMON = [
  'password', 'passw0rd', 'welcome', 'qwerty', 'letmein', 'admin', 'administrator',
  'changeme', 'iloveyou', 'monkey', 'dragon', 'football', 'sunshine', 'princess',
  'abc123', '123456', '12345678', '123456789', '1234567890', 'construction',
  'siteops', 'gkuc', 'colombo', 'srilanka'
];

const KEYBOARD_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

export function passwordProblems(password, { email = '', name = '' } = {}) {
  const problems = [];
  const value = String(password || '');
  const lower = value.toLowerCase();

  if (value.length < MIN_LENGTH) problems.push(`be at least ${MIN_LENGTH} characters`);

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(value)).length;
  if (classes < 3) problems.push('mix upper and lower case, numbers or symbols');

  if (TOO_COMMON.some(common => lower.includes(common))) problems.push('not be built on a commonly used word');

  if (/^(.)\1+$/.test(value)) problems.push('not be the same character repeated');

  if (KEYBOARD_RUNS.some(run => {
    for (let start = 0; start + 4 <= run.length; start += 1) {
      if (lower.includes(run.slice(start, start + 4))) return true;
    }
    return false;
  })) problems.push('not run along the keyboard');

  /* A password containing the person's own address or name is the first thing guessed. */
  const localPart = String(email).split('@')[0].toLowerCase();
  if (localPart.length > 2 && lower.includes(localPart)) problems.push('not contain your email address');
  for (const part of String(name).toLowerCase().split(/\s+/)) {
    if (part.length > 2 && lower.includes(part)) { problems.push('not contain your name'); break; }
  }

  return problems;
}

/** A zod refinement so routes state the rule once and report it the same way everywhere. */
export const strongPassword = z.string().superRefine((value, context) => {
  for (const problem of passwordProblems(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `The password must ${problem}` });
  }
});
