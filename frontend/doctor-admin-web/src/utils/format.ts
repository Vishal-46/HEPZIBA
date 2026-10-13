/** Format an ISO date string for display; never throws. */
export function formatDate(value?: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleString();
}

/**
 * Mask an Aadhaar number for display: "XXXX-XXXX-1234".
 * Returns an em dash placeholder when absent.
 */
export function maskAadhaar(value?: string | number | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 0) return '—';
  const last4 = digits.slice(-4).padStart(4, '•');
  return `XXXX-XXXX-${last4}`;
}

/** Case-insensitive multi-field search filter. */
export function filterByQuery<T>(
  rows: T[],
  query: string,
  pick: (row: T) => Array<string | number | null | undefined>,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => pick(row).some((v) => String(v ?? '').toLowerCase().includes(q)));
}

/** Slice a list into a 1-based page. Returns clamped page + total pages. */
export function paginate<T>(rows: T[], page: number, pageSize: number): {
  pageRows: T[];
  page: number;
  totalPages: number;
  total: number;
} {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    pageRows: rows.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    total,
  };
}
