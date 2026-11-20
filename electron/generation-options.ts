// The Doubao video toolbar slider currently spans 4s to 15s. These bounds are
// validated before a task is created so an unsupported value never reaches the
// execution window.
export const DOUBAO_DURATION_MIN_SECONDS = 4;
export const DOUBAO_DURATION_MAX_SECONDS = 15;

export function normalizeDoubaoDurationSeconds(value: unknown): number | null {
  if (value === undefined || value === null || typeof value === "boolean") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.0+)?$/.test(text)) return null;
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds)) return null;
  if (seconds < DOUBAO_DURATION_MIN_SECONDS || seconds > DOUBAO_DURATION_MAX_SECONDS) return null;
  return seconds;
}

export function formatDoubaoDurationSeconds(seconds: number | null | undefined) {
  return seconds ? `${seconds} 秒` : null;
}
