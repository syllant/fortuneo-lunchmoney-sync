export class DomainError extends Error {
  constructor(public readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "DomainError";
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  return "UNEXPECTED_ERROR";
}
