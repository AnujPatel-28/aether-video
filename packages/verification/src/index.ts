import { z } from 'zod';
import { resultFields } from './result-fields.js';

// Public mechanical result shape only; no checks/evaluator behavior yet.
export const MechanicalVerificationResultSchema = z.strictObject({
  ...resultFields, scope: z.literal('mechanical'),
});
export type MechanicalVerificationResult = z.infer<typeof MechanicalVerificationResultSchema>;
