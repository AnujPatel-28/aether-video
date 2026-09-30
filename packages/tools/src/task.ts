import { z } from 'zod';
import { DurationTargetSchema, IdSchema, SourceRefSchema } from '@aether/core';

export const TaskInstructionsSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, rawRequest: z.string().min(1),
  userProvidedDurationTarget: DurationTargetSchema.optional(),
  userProvidedSourceSelections: z.array(SourceRefSchema),
});
export type TaskInstructions = z.infer<typeof TaskInstructionsSchema>;
