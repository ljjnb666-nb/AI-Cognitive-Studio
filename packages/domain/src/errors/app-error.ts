export class AppError extends Error {
  public readonly code: string;
  public readonly details?: unknown;
  public readonly retryable: boolean;

  public constructor(options: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}
