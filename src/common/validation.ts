import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { HttpError } from './http-error.js';

/** The first problem found, as one sentence for the client (nested errors included, e.g. one link of many). */
function firstMessage(errors: ValidationError[]): string | undefined {
  for (const e of errors) {
    const message = e.constraints ? Object.values(e.constraints)[0] : firstMessage(e.children ?? []);
    if (message) return message;
  }
  return undefined;
}

/**
 * Checks request bodies against their DTO classes (class-validator). Unknown fields are dropped, and a failure is a
 * 400 with the first problem as the error message, like every other API error.
 */
export function validationPipe() {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    stopAtFirstError: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new HttpError(400, firstMessage(errors) ?? 'Invalid request'),
  });
}
