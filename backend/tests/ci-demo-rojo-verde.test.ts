import { expect, it } from "vitest";

it("demostracion de CI: el ejemplo contiene dos transiciones", () => {
  const transitions = ["CREATE", "CANCEL"];
  expect(transitions).toHaveLength(3);
});
