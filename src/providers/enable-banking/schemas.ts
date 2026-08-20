import { DomainError } from "../../domain/errors";

export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) throw new DomainError("ENABLE_BANKING_INVALID_RESPONSE");
  return value;
}

export function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requiredObject(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (!isObject(value)) throw new DomainError("ENABLE_BANKING_INVALID_RESPONSE");
  return value;
}

export function objectArray(object: JsonObject, key: string): JsonObject[] {
  const value = object[key];
  if (!Array.isArray(value) || !value.every(isObject)) throw new DomainError("ENABLE_BANKING_INVALID_RESPONSE");
  return value;
}
