export type SwitchboardErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'THROTTLED'
  | 'INTERNAL_ERROR'
  | 'UNAVAILABLE';

export class SwitchboardError extends Error {
  public readonly code: SwitchboardErrorCode;
  public readonly statusCode: number;
  public readonly retryAfterSeconds?: number;
  public readonly details?: unknown;

  constructor(
    code: SwitchboardErrorCode,
    message: string,
    options?: {
      statusCode?: number;
      retryAfterSeconds?: number;
      details?: unknown;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = 'SwitchboardError';
    this.code = code;
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;

    if (options?.statusCode) {
      this.statusCode = options.statusCode;
    } else {
      switch (code) {
        case 'INVALID_INPUT':
          this.statusCode = 400;
          break;
        case 'UNAUTHORIZED':
          this.statusCode = 401;
          break;
        case 'FORBIDDEN':
          this.statusCode = 403;
          break;
        case 'NOT_FOUND':
          this.statusCode = 404;
          break;
        case 'CONFLICT':
          this.statusCode = 409;
          break;
        case 'PAYLOAD_TOO_LARGE':
          this.statusCode = 413;
          break;
        case 'THROTTLED':
          this.statusCode = 429;
          break;
        case 'UNAVAILABLE':
          this.statusCode = 503;
          break;
        case 'INTERNAL_ERROR':
        default:
          this.statusCode = 500;
          break;
      }
    }

    if (options?.cause) {
      this.cause = options.cause;
    }
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        retryAfterSeconds: this.retryAfterSeconds,
      },
    };
  }
}
