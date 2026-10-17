import type { z } from 'zod';
import { validationError } from './errors.js';

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(
      'Please correct the highlighted fields',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
