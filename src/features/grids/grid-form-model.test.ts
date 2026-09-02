import { describe, expect, it } from "vitest";

import {
  defaultGridFormValues,
  detailToFormValues,
  validateGridForm,
  type GridFormValues,
} from "./grid-form-model";
import type { GridTradeDetail } from "./types";

describe("grid form model", () => {
  it("provides the Android-compatible defaults", () => {
    expect(defaultGridFormValues).toEqual({
      productName: "",
      productCode: "",
      maxPrice: "1",
      minTradeQuantity: "100",
      gearAmplitude: "5",
      perShare: "2000",
      keepShare: "2",
      increaseAmplitude: "5",
      mediumAmplitude: "15",
      bigAmplitude: "30",
      maxAmplitude: "60",
      isShort: false,
      category: "",
      sortOrder: "0",
    });
  });

  it("trims text and numeric form values during conversion", () => {
    const values: GridFormValues = {
      ...defaultGridFormValues,
      productName: "  黄金 ETF  ",
      productCode: "  518880  ",
      maxPrice: " 12.5 ",
      minTradeQuantity: " 100 ",
      gearAmplitude: " 5 ",
      perShare: " 2000 ",
      category: "  ETF  ",
      sortOrder: " 3 ",
    };

    expect(validateGridForm(values)).toEqual({
      input: {
        productName: "黄金 ETF",
        productCode: "518880",
        maxPrice: "12.5",
        minTradeQuantity: "100",
        gearAmplitude: "5",
        perShare: "2000",
        keepShare: 2,
        increaseAmplitude: 5,
        mediumAmplitude: 15,
        bigAmplitude: 30,
        maxAmplitude: 60,
        isShort: false,
        category: "ETF",
        sortOrder: 3,
      },
      fieldErrors: {},
    });
  });

  it("accepts human decimal notation without exponent form", () => {
    const result = validateGridForm({
      ...defaultGridFormValues,
      productCode: "518880",
      maxPrice: "12",
      minTradeQuantity: "12.5",
      gearAmplitude: "12.",
      perShare: ".5",
    });

    expect(result.fieldErrors).toEqual({});
    expect(result.input).toMatchObject({
      maxPrice: "12",
      minTradeQuantity: "12.5",
      gearAmplitude: "12.",
      perShare: ".5",
    });
  });

  it("rejects a non-positive required decimal", () => {
    const result = validateGridForm({ ...defaultGridFormValues, maxPrice: "0" });
    expect(result.input).toBeUndefined();
    expect(result.fieldErrors.maxPrice).toContain("最高价格必须大于 0");
  });

  it("rejects a maximum amplitude above one hundred", () => {
    const result = validateGridForm({ ...defaultGridFormValues, maxAmplitude: "101" });
    expect(result.input).toBeUndefined();
    expect(result.fieldErrors.maxAmplitude).toContain("最大振幅必须介于 1 和 100 之间");
  });

  it("rejects malformed and unsafe integer values", () => {
    const result = validateGridForm({
      ...defaultGridFormValues,
      keepShare: "-1",
      increaseAmplitude: "1.5",
      sortOrder: "9007199254740992",
    });

    expect(result.input).toBeUndefined();
    expect(result.fieldErrors.keepShare).toContain("留存份数必须为非负整数");
    expect(result.fieldErrors.increaseAmplitude).toContain("加码幅度必须为非负整数");
    expect(result.fieldErrors.sortOrder).toContain("排序必须为整数");
  });

  it("allows blank optional long-only amplitudes", () => {
    const result = validateGridForm({
      ...defaultGridFormValues,
      productCode: "518880",
      mediumAmplitude: "  ",
      bigAmplitude: "",
    });

    expect(result.fieldErrors).toEqual({});
    expect(result.input).toMatchObject({ mediumAmplitude: null, bigAmplitude: null });
  });

  it("clears long-only values before a short submission", () => {
    const result = validateGridForm({
      ...defaultGridFormValues,
      productCode: "518880",
      isShort: true,
      keepShare: "2",
      mediumAmplitude: "15",
      bigAmplitude: "30",
    });
    expect(result.input).toMatchObject({
      isShort: true,
      keepShare: 0,
      mediumAmplitude: null,
      bigAmplitude: null,
    });
  });

  it("maps a detail DTO back to browser form values", () => {
    const detail = {
      id: "grid-1",
      productName: null,
      productCode: "518880",
      maxPrice: "1",
      perShare: "2000",
      isShort: true,
      algorithmVersion: "android-v2.1.0",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      input: {
        productName: null,
        productCode: "518880",
        maxPrice: "1",
        minTradeQuantity: "100",
        gearAmplitude: "5",
        perShare: "2000",
        keepShare: 0,
        increaseAmplitude: 5,
        mediumAmplitude: null,
        bigAmplitude: null,
        maxAmplitude: 60,
        isShort: true,
        category: null,
        sortOrder: 0,
        algorithmVersion: "android-v2.1.0",
      },
      calculation: {
        items: [],
        totalBuyAmount: "0",
        totalProfitAmount: "0",
        totalProfitRate: "0",
      },
    } satisfies GridTradeDetail;

    expect(detailToFormValues(detail)).toEqual({
      productName: "",
      productCode: "518880",
      maxPrice: "1",
      minTradeQuantity: "100",
      gearAmplitude: "5",
      perShare: "2000",
      keepShare: "0",
      increaseAmplitude: "5",
      mediumAmplitude: "",
      bigAmplitude: "",
      maxAmplitude: "60",
      isShort: true,
      category: "",
      sortOrder: "0",
    });
  });
});
