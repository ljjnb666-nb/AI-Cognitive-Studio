type LogLevel = "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

function write(level: LogLevel, event: string, context: LogContext = {}): void {
  const entry = JSON.stringify({ level, event, ...context, timestamp: new Date().toISOString() });
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
