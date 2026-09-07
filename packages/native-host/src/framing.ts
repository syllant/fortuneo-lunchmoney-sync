import type { Readable, Writable } from "node:stream";
import { MAX_NATIVE_MESSAGE_BYTES } from "../../shared/src/messages.js";

export async function* readNativeMessages(input: Readable): AsyncGenerator<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of input) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    buffered = Buffer.concat([buffered, next]);
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) throw new Error("NATIVE_MESSAGE_SIZE_INVALID");
      if (buffered.byteLength < length + 4) break;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8")) as unknown;
      } catch (error) {
        throw new Error("NATIVE_MESSAGE_JSON_INVALID", { cause: error });
      }
      yield parsed;
    }
  }
  if (buffered.byteLength !== 0) throw new Error("NATIVE_MESSAGE_TRUNCATED");
}

export function writeNativeMessage(output: Writable, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_NATIVE_MESSAGE_BYTES) throw new Error("NATIVE_RESPONSE_TOO_LARGE");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.byteLength, 0);
  output.write(Buffer.concat([header, body]));
}
