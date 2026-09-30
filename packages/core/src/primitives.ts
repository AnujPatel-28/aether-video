import { z } from 'zod';

export const IdSchema = z.string().min(1).regex(/\S/, 'ID must not be blank');
export const UIntSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PositiveIntSchema = UIntSchema.refine(value => value > 0, 'Must be positive');
export const MsSchema = UIntSchema;
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Lowercase SHA-256 digest');
export const RangeSchema = z.strictObject({ startMs: MsSchema, endMs: MsSchema })
  .refine(value => value.endMs > value.startMs, 'Non-empty half-open range');
export const SourceRefSchema = z.strictObject({ assetId: IdSchema, range: RangeSchema });
export const DurationTargetSchema = z.strictObject({ minMs: MsSchema, maxMs: MsSchema })
  .refine(value => value.minMs <= value.maxMs && value.maxMs > 0, 'Invalid duration target');

export type Range = z.infer<typeof RangeSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type DurationTarget = z.infer<typeof DurationTargetSchema>;
