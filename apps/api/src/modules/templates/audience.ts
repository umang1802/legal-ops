import { INTERNAL_ONLY_VARIABLES } from '@legalops/types';
import { templateVariables } from './render.js';

export type Audience = 'client' | 'internal';
type Vars = Record<string, Record<string, unknown>>;

/**
 * Drops team-only values before anything is rendered for a client, so no template (not even one a
 * firm edited, or a legacy row) can show an internal note. Team emails are returned as-is.
 */
export function varsForAudience(vars: Vars, audience: Audience): Vars {
  if (audience !== 'client') return vars;
  const out: Vars = Object.fromEntries(Object.entries(vars).map(([group, values]) => [group, { ...values }]));
  for (const path of INTERNAL_ONLY_VARIABLES) {
    const [group, key] = path.split('.') as [string, string];
    if (out[group]) delete out[group][key];
  }
  return out;
}

/** Team-only variables referenced by any of the given template strings, in catalogue order. */
export function internalOnlyUsed(...templates: (string | null | undefined)[]): string[] {
  const used = new Set(templates.flatMap((t) => (t ? templateVariables(t) : [])));
  return INTERNAL_ONLY_VARIABLES.filter((v) => used.has(v));
}
