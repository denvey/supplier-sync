const POSTGRES_NUL = /\u0000/g;

export function sanitizePostgresText(value: string, maxLength?: number) {
  const sanitized = value.replace(POSTGRES_NUL, "");
  return maxLength === undefined ? sanitized : sanitized.slice(0, maxLength);
}

export function formatPostgresErrorMessage(error: unknown, maxLength = 4000) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizePostgresText(message, maxLength);
}

export function sanitizePostgresJson(value: unknown): unknown {
  return sanitizeJsonValue(value, new WeakSet<object>());
}

function sanitizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizePostgresText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || value === null) return value;

  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      sanitizePostgresText(key),
      sanitizeJsonValue(item, seen)
    ])
  );
}
