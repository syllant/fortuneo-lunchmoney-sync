import { describe, expect, it } from "vitest";
import { LunchMoneyGateway } from "../../packages/native-host/src/lunch-money.js";

describe("Lunch Money managed settings", () => {
  it("requires only lifecycle tags and never reads or modifies categories", async () => {
    const gateway = new LunchMoneyGateway("test-token");
    Object.defineProperty(gateway, "client", { value: {
      tags: { getAll: async () => [{ id: 20, name: "Fortuneo pending", archived: false }, { id: 21, name: "Fortuneo deferred", archived: false }] },
      get categories() { throw new Error("Categories must remain untouched"); },
    } });
    await expect(gateway.ensureManagedIds(10, false)).resolves.toEqual({ checkingAccountId: 10, pendingTagId: 20, deferredTagId: 21 });
  });
});
