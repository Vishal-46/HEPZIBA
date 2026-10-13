type ListControlsProps = {
  query: string;
  onQuery: (q: string) => void;
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  total: number;
  label: string;
  searchLabel?: string;
};

export function SearchInput({
  query,
  onQuery,
  label,
}: {
  query: string;
  onQuery: (q: string) => void;
  label: string;
}) {
  return (
    <label className="searchField">
      <span className="visuallyHidden">{label}</span>
      <input
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={label}
        aria-label={label}
      />
    </label>
  );
}

export function Pager({
  page,
  totalPages,
  onPage,
  total,
  label,
}: Omit<ListControlsProps, 'query' | 'onQuery' | 'searchLabel'>) {
  if (total === 0) return null;
  return (
    <nav className="pager" aria-label={`${label} pagination`}>
      <button
        type="button"
        className="ghostBtn pagerBtn"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        aria-label="Previous page"
      >
        ‹ Prev
      </button>
      <span className="pagerStatus" aria-live="polite">
        Page {page} of {totalPages} · {total} total
      </span>
      <button
        type="button"
        className="ghostBtn pagerBtn"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        aria-label="Next page"
      >
        Next ›
      </button>
    </nav>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="emptyState" role="status">
      <p className="muted">{message}</p>
    </div>
  );
}

export function LoadingState({ message = 'Loading…' }: { message?: string }) {
  return (
    <div className="loadingState" role="status" aria-busy="true" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p className="muted">{message}</p>
    </div>
  );
}
