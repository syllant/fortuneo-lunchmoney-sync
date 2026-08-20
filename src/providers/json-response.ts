import { DomainError } from "../domain/errors";
import { isObject, type JsonObject } from "./enable-banking/schemas";

const MAX_RESPONSE_BYTES = 2_000_000;

export async function readBoundedJsonObject(
  response: Response,
  tooLargeCode: string,
  invalidCode: string,
): Promise<JsonObject> {
  const declaredLength = Number(response.headers.get("Content-Length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new DomainError(tooLargeCode);
  }
  if (!response.body) throw new DomainError(invalidCode);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DomainError(tooLargeCode);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(invalidCode, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new DomainError(invalidCode, { cause: error });
  }
  if (!isObject(value)) throw new DomainError(invalidCode);
  return value;
}
