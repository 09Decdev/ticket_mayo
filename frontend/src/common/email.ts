export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedEmails {
  raw: string;
  total: number;
  valid: string[];
  invalid: string[];
  duplicatesDropped: number;
}

export function parseEmails(raw: string): ParsedEmails {
  const tokens = raw
    .split(/[\s,;]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicatesDropped = 0;
  for (const tok of tokens) {
    const norm = tok.toLowerCase();
    if (!EMAIL_REGEX.test(norm)) {
      if (!invalid.includes(tok)) invalid.push(tok);
      continue;
    }
    if (seen.has(norm)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(norm);
    valid.push(norm);
  }
  return { raw, total: tokens.length, valid, invalid, duplicatesDropped };
}
