"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
exports.errorMessage = errorMessage;
class AppError extends Error {
    code;
    status;
    retryable;
    constructor(code, status, message, retryable = false) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.name = "AppError";
    }
}
exports.AppError = AppError;
function errorMessage(error) {
    return error instanceof Error
        ? error.message
        : String(error);
}
