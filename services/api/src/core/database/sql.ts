/** Build an ILIKE pattern for a "contains" search, escaping LIKE wildcards in user input. */
export function containsPattern(term: string | undefined): string | null {
  if (!term) return null;
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
