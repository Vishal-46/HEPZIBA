/**
 * Legacy appointment rows may still say `completed`; the canonical value used
 * by the database, docs and filters is `done`.
 */
export function normalizeAppointmentStatus(value: unknown): string {
  return value === 'completed' ? 'done' : String(value || 'pending');
}
