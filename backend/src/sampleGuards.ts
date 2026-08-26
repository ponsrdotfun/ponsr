/**
 * Guards for the latency sampler: hostile public JSON in, safe rows out.
 *
 * WHY A SAMPLER NEEDS GUARDS AT ALL
 * ---------------------------------
 * It reads the same public endpoints anyone can read, so it must survive whatever they
 * return. The first version dereferenced `body.checks` and `body.dependencies` without
 * checking their shape, so a null row or a wrong-typed element could abort an entire
 * sampling run -- turning "the endpoint answered something odd" into "we have no data",
 * which is the worst outcome for a measurement tool.
 *
 * And CSV is a format with two well-known ways to go wrong. A field containing a comma or
 * a quote silently shifts every column after it. A field beginning `=`, `+`, `-` or `@` is
 * executed as a FORMULA by spreadsheet software, so a hostile string in a public response
 * becomes code in whatever an operator opens the file with. Both are handled here.
 */

/** A check row that survived shape validation. Anything else is dropped, never trusted. */
export interface SafeCheck {
  name: string;
  state: string;
}

/** A dependency timing row that survived shape validation. */
export interface SafeDependency {
  name: string;
  ms: number;
  outcome: string;
}

const NAME = /^[a-z0-9-]{1,40}$/;
/** A cell starting with any of these is executed as a formula by spreadsheet software. */
const FORMULA_LEAD = new RegExp('^[=+@\t\r-]');
/** A cell containing any of these breaks column alignment unless it is quoted. */
const NEEDS_QUOTES = new RegExp('[",\r\n]');
const STATE = /^[a-z-]{1,20}$/;

/**
 * Check rows, filtered to the ones that are actually well-formed.
 *
 * Returns an empty array for any input that is not an array. A malformed element is
 * skipped rather than throwing, because one odd row must not cost the whole run.
 */
export function safeChecks(raw: unknown): SafeCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: SafeCheck[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string' || !NAME.test(r.name)) continue;
    if (typeof r.state !== 'string' || !STATE.test(r.state)) continue;
    out.push({ name: r.name, state: r.state });
  }
  return out;
}

/** Dependency timing rows, filtered the same way. */
export function safeDependencies(raw: unknown): SafeDependency[] {
  if (!Array.isArray(raw)) return [];
  const out: SafeDependency[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string' || !NAME.test(r.name)) continue;
    if (typeof r.ms !== 'number' || !Number.isFinite(r.ms) || r.ms < 0) continue;
    if (typeof r.outcome !== 'string' || !STATE.test(r.outcome)) continue;
    out.push({ name: r.name, ms: r.ms, outcome: r.outcome });
  }
  return out;
}

/**
 * One CSV field, RFC 4180 quoted and neutralised against spreadsheet formula injection.
 *
 * The leading apostrophe is what stops Excel, LibreOffice and Sheets treating a cell as a
 * formula. Quoting alone does not: `"=cmd()"` is still parsed as a formula once the quotes
 * are consumed by the CSV reader.
 */
export function csvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // The leading apostrophe is what stops a cell being parsed as a formula. Quoting alone
  // does not: "=cmd()" is still a formula once the CSV reader consumes the quotes.
  if (FORMULA_LEAD.test(s)) s = "'" + s;
  if (NEEDS_QUOTES.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** A full CSV row from already-safe values. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvField).join(',');
}
