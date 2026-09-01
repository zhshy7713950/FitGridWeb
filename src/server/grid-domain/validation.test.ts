import { describe, expect, it } from "vitest";

import fixture from "../../../docs/fit-replication/fixtures/grid-algorithm-v2.1.0.json";
import { validateGridInput } from "@/server/grid-domain/validation";
import type { GridTradeInput } from "@/server/grid-domain/types";

const validInput: GridTradeInput = {
  productName: "  示例产品  ",
  productCode: "  DEMO001  ",
  maxPrice: "1",
  minTradeQuantity: "100",
  gearAmplitude: "5",
  perShare: "2000",
  keepShare: 2,
  increaseAmplitude: 5,
  mediumAmplitude: 15,
  bigAmplitude: 30,
  maxAmplitude: 60,
  isShort: false,
  category: "  ",
  sortOrder: 0,
  algorithmVersion: "android-v2.1.0",
};

describe("validateGridInput", () => {
  for (const validationCase of fixture.webValidationCases) {
    it(`rejects ${validationCase.id} with its stable code`, () => {
      expect(() =>
        validateGridInput({ ...validInput, ...validationCase.patch }),
      ).toThrowError(expect.objectContaining({ code: validationCase.expectedCode }));
    });
  }

  it.each([
    ["1e3", "DECIMAL_FORMAT_INVALID"],
    ["NaN", "DECIMAL_FORMAT_INVALID"],
    ["123456789012345678901", "DECIMAL_PRECISION_EXCEEDED"],
    ["1.12345678901", "DECIMAL_PRECISION_EXCEEDED"],
  ])("rejects unsafe decimal %s", (maxPrice, code) => {
    expect(() => validateGridInput({ ...validInput, maxPrice })).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("normalizes strings and ignores unsupported short-only fields", () => {
    expect(
      validateGridInput({
        ...validInput,
        isShort: true,
        productName: "  ",
        category: "  watch  ",
      }),
    ).toEqual({
      ...validInput,
      isShort: true,
      productName: null,
      productCode: "DEMO001",
      category: "watch",
      keepShare: 0,
      mediumAmplitude: null,
      bigAmplitude: null,
    });
  });

  it.each([
    ["keepShare", -1, "KEEP_SHARE_MUST_BE_NON_NEGATIVE"],
    ["increaseAmplitude", -1, "INCREASE_AMPLITUDE_MUST_BE_NON_NEGATIVE"],
    ["maxAmplitude", 1.5, "MAX_AMPLITUDE_MUST_BE_INTEGER"],
    ["sortOrder", 1.5, "SORT_ORDER_MUST_BE_INTEGER"],
  ] as const)("rejects invalid integer field %s", (field, value, code) => {
    expect(() => validateGridInput({ ...validInput, [field]: value })).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});
