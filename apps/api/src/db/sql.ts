/**
 * Minimal tagged-template SQL builder. Every interpolated value becomes a bound parameter,
 * so string concatenation of user input into SQL is impossible by construction.
 * Fragments compose: sql`... WHERE ${visibility}` renumbers placeholders automatically.
 */
export class SqlFragment {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  toQuery(): { text: string; values: unknown[] } {
    const out: unknown[] = [];
    const text = render(this, out);
    return { text, values: out };
  }
}

/** Trusted, code-authored SQL text (identifiers, keywords). Never pass user input. */
class RawSql {
  constructor(readonly text: string) {}
}

function render(fragment: SqlFragment, out: unknown[]): string {
  let text = fragment.strings[0] ?? '';
  fragment.values.forEach((value, i) => {
    if (value instanceof SqlFragment) text += render(value, out);
    else if (value instanceof RawSql) text += value.text;
    else {
      out.push(value);
      text += `$${out.length}`;
    }
    text += fragment.strings[i + 1] ?? '';
  });
  return text;
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return new SqlFragment(strings, values);
}

sql.raw = (text: string): RawSql => new RawSql(text);

sql.join = (fragments: readonly SqlFragment[], separator = ', '): SqlFragment => {
  if (fragments.length === 0) return sql``;
  const strings = ['', ...fragments.slice(1).map(() => separator), ''];
  return new SqlFragment(strings, fragments);
};

sql.empty = new SqlFragment([''], []);
