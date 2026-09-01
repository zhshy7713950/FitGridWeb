import { z } from "zod";

import { validateGridInput } from "@/server/grid-domain/validation";
import type { GridTradeInput } from "@/server/grid-domain/types";

const decimalString = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const nullableText = z.string().max(120).nullable();

const mutationFields = {
  productName: nullableText,
  productCode: z.string().min(1).max(64),
  maxPrice: decimalString,
  minTradeQuantity: decimalString,
  gearAmplitude: decimalString,
  perShare: decimalString,
  keepShare: z.number().int().nonnegative(),
  increaseAmplitude: z.number().int().nonnegative(),
  mediumAmplitude: z.number().int().positive().nullable(),
  bigAmplitude: z.number().int().positive().nullable(),
  maxAmplitude: z.number().int().min(1).max(100),
  isShort: z.boolean(),
  category: nullableText,
  sortOrder: z.number().int(),
} as const;

const createSchema = z
  .strictObject({
    productName: mutationFields.productName.optional().default(null),
    productCode: mutationFields.productCode,
    maxPrice: mutationFields.maxPrice,
    minTradeQuantity: mutationFields.minTradeQuantity,
    gearAmplitude: mutationFields.gearAmplitude,
    perShare: mutationFields.perShare,
    keepShare: mutationFields.keepShare,
    increaseAmplitude: mutationFields.increaseAmplitude,
    mediumAmplitude: mutationFields.mediumAmplitude.optional().default(null),
    bigAmplitude: mutationFields.bigAmplitude.optional().default(null),
    maxAmplitude: mutationFields.maxAmplitude,
    isShort: mutationFields.isShort,
    category: mutationFields.category.optional().default(null),
    sortOrder: mutationFields.sortOrder.optional().default(0),
  });

const updateSchema = z.strictObject({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  productName: mutationFields.productName.optional(),
  productCode: mutationFields.productCode.optional(),
  maxPrice: mutationFields.maxPrice.optional(),
  minTradeQuantity: mutationFields.minTradeQuantity.optional(),
  gearAmplitude: mutationFields.gearAmplitude.optional(),
  perShare: mutationFields.perShare.optional(),
  keepShare: mutationFields.keepShare.optional(),
  increaseAmplitude: mutationFields.increaseAmplitude.optional(),
  mediumAmplitude: mutationFields.mediumAmplitude.optional(),
  bigAmplitude: mutationFields.bigAmplitude.optional(),
  maxAmplitude: mutationFields.maxAmplitude.optional(),
  isShort: mutationFields.isShort.optional(),
  category: mutationFields.category.optional(),
  sortOrder: mutationFields.sortOrder.optional(),
});

export type GridUpdateDto = z.output<typeof updateSchema>;

export function parseGridCreate(value: unknown): GridTradeInput {
  return validateGridInput({
    ...createSchema.parse(value),
    algorithmVersion: "android-v2.1.0",
  });
}

export function parseGridUpdate(value: unknown): GridUpdateDto {
  return updateSchema.parse(value);
}
