import { describe, expect, it } from "vitest";
import { errorCode } from "../../src/domain/errors";
import { objectArray, requiredObject, requiredString } from "../../src/providers/enable-banking/schemas";

describe("Enable Banking response validation", () => {
  it("classifies missing required response fields without exposing payload data", () => {
    for (const parse of [
      () => requiredString({}, "url"),
      () => requiredObject({}, "access"),
      () => objectArray({}, "accounts"),
    ]) {
      try {
        parse();
        throw new Error("Expected response validation to fail");
      } catch (error) {
        expect(errorCode(error)).toBe("ENABLE_BANKING_INVALID_RESPONSE");
      }
    }
  });
});
