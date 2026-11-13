export function safePathSegment(value: string, fallback = 'item'): string {
  let name = value.normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 90)
    .replace(/[.\s-]+$/g, '');
  if (!name) name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function truncateSheetName(value: string, length: number): string {
  return value.slice(0, length).replace(/[\uD800-\uDBFF]$/u, '').replace(/'+$/g, '');
}

export function createSheetNames(serviceNames: readonly string[]): string[] {
  const used = new Set(['summary', 'history']);
  return serviceNames.map((serviceName) => {
    const cleaned = serviceName.replace(/[\\/?*\[\]:\x00-\x1f]/g, '-')
      .trim().replace(/^'+|'+$/g, '').trim().replace(/'/g, '-');
    const base = truncateSheetName(cleaned || 'Service', 31) || 'Service';
    let candidate = base;
    let sequence = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = `-${sequence++}`;
      candidate = `${truncateSheetName(base, 31 - suffix.length)}${suffix}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export function safeExcelText(value: string): string {
  const cleaned = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return /^[\s\uFEFF]*[=+\-@]/u.test(cleaned) ? `'${cleaned}` : cleaned;
}

export function sheetHyperlink(sheetName: string): string {
  return `#'${sheetName.replace(/'/g, "''")}'!A1`;
}

export function formatSydneyTime(value: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short',
  }).format(value);
}