import { z } from 'zod';
import { DigestSchema, IdSchema, SourceRefSchema } from '@aether/core';

export const resultFields = {
  schemaVersion: z.literal(1), checkId: IdSchema,
  kind: z.enum(['deterministic', 'model_assisted']), status: z.enum(['pass', 'fail', 'review']),
  evidence: z.array(z.strictObject({
    message: z.string(), source: SourceRefSchema.optional(), artifactId: IdSchema.optional(),
  })).min(1),
  confidence: z.number().min(0).max(1).optional(), evaluatedContentHash: DigestSchema,
};
