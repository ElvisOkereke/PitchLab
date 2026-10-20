import { STATUS_LABEL, type CheckCell, type ClaimStatus } from '@bcg/core/case/review';

/** A claim's verification status as a coloured chip ("✅ verified", "⚠️ unreachable", …). */
export function StatusChip({ status }: { status: ClaimStatus }) {
  return (
    <span className={`chip chip-${status}`} data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** A competitor check cell: a chip with the export's exact wording, or plain text when no claim is behind it. */
export function CheckChip({ cell }: { cell: CheckCell }) {
  if (cell.status === null) return <span className="muted">{cell.text}</span>;
  return (
    <span className={`chip chip-${cell.status}`} data-status={cell.status}>
      {cell.text}
    </span>
  );
}
