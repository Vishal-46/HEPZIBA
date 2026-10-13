import { useCallback, useMemo, useState } from 'react';
import { filterByQuery, paginate } from '../utils/format';

/**
 * Combined search-filter + pagination slice for list views.
 * Page resets to 1 on query change via the wrapped setter (no effect needed);
 * source-list shrinkage is handled by paginate()'s clamping.
 */
export function usePaginatedSearch<T>(
  rows: T[],
  pick: (row: T) => Array<string | number | null | undefined>,
  pageSize = 8,
) {
  const [query, setQueryState] = useState('');
  const [page, setPage] = useState(1);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setPage(1);
  }, []);

  const filtered = useMemo(() => filterByQuery(rows, query, pick), [rows, query, pick]);

  const { pageRows, totalPages, total, page: safePage } = useMemo(
    () => paginate(filtered, page, pageSize),
    [filtered, page, pageSize],
  );

  return {
    query,
    setQuery,
    page: safePage,
    setPage,
    pageRows,
    totalPages,
    total,
    filteredCount: filtered.length,
  };
}
