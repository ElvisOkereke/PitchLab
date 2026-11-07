/**
 * Sets KEY=value lines in .env text. Replaces the first live `KEY=` line (later duplicates are removed), appends
 * missing keys, and keeps every other line, comment, the order and the file's line endings (CRLF if the file uses it).
 * Pure: no file access. Values are written raw (the .env format here has no quoting), so line breaks are refused.
 */
export function setEnvValues(text: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`The value for ${key} contains a line break.`);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // Lines without their breaks; a final '' means the text ended with a break.
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = Object.keys(values).find((k) => line.startsWith(`${k}=`));
    if (key === undefined) {
      out.push(line);
    } else if (!done.has(key)) {
      done.add(key);
      out.push(`${key}=${values[key]}`);
    } // else: a later duplicate of a key already set, dropped
  }
  for (const [key, value] of Object.entries(values)) if (!done.has(key)) out.push(`${key}=${value}`);
  return out.length === 0 ? '' : out.join(eol) + eol;
}
