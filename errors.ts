
export type AppErrorCode =
  | "INVALID_URL"
  | "INVALID_XML"
  | "UNSUPPORTED_FORMAT"
  | "FETCH_FAILED"
  | "FETCH_TIMEOUT"
  | "HTTP_ERROR"
  | "TOO_MANY_REDIRECTS"
  | "FEED_TOO_LARGE"
  | "FEED_NOT_FOUND"
  | "BAD_REQUEST"
  | "REQUEST_TOO_LARGE"
  | "INTERNAL_ERROR";

export interface ApiErrorResponse {
  error: string;
  code: AppErrorCode;
}

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    public readonly status: number,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}
