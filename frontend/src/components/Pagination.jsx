// Prev/Next pager with a "X–Y of Z" summary. Shared by every list screen
// that now does real limit/skip pagination (Stage 8).
export default function Pagination({ page, limit, total, onPageChange }) {
  if (total === 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between px-2 py-3 text-sm text-gray-600">
      <span>
        {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="px-3 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Prev
        </button>
        <span>Page {page} of {totalPages}</span>
        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="px-3 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}