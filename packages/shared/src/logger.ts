type LogLevel = "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

const sensitiveKey = /(?:authorization|cookie|credential|secret|api[_-]?key|keyring|password|token)/i;
const sensitiveValue = /(?:sk-[\w-]+|bearer\s+\S+|basic\s+\S+)/i;
const REDACTED = "[REDACTED]";

/** Keeps diagnostics useful while ensuring credentials and request secrets never cross a log boundary. */
export function redactSensitive(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return REDACTED;
  if (typeof value === "string") return sensitiveValue.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redactSensitive(entryValue, entryKey)]));
  return value;
}

function write(level: LogLevel, event: string, context: LogContext = {}): void {
  const entry = JSON.stringify({ level, event, ...(redactSensitive(context) as LogContext), timestamp: new Date().toISOString() });
  if (level === "error") {
    console.error(entry);
    return;
  }

  if (level === "warn") {
    console.warn(entry);
    return;
  }

  console.info(entry);
}

export const logger = {
  info: (event: string, context?: LogContext) => write("info", event, context),
  warn: (event: string, context?: LogContext) => write("warn", event, context),
  error: (event: string, context?: LogContext) => write("error", event, context),
};
