import { z } from 'zod';
import { DigestSchema, DurationTargetSchema, IdSchema, MsSchema, SourceRefSchema } from '@aether/core';

// Separate optional AETHER representation. Not re-exported by the shared tool entry.
export const IntentItemSchema = z.strictObject({
  description: z.string().min(1), inferredRanges: z.array(SourceRefSchema),
});
export const EditContractSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, taskId: IdSchema,
  objective: z.string().min(1), targetDuration: DurationTargetSchema.optional(),
  preserve: z.array(IntentItemSchema), protect: z.array(IntentItemSchema),
  allow: z.array(z.string()), avoid: z.array(z.string()),
  autonomy: z.enum(['propose_only', 'edit_candidate']),
  successCriteria: z.array(z.strictObject({ id: IdSchema, description: z.string() })),
});
export const EditorialPlanSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, contractId: IdSchema, baseContentHash: DigestSchema,
  selectedSegments: z.array(IdSchema), removedSegments: z.array(IdSchema),
  reorderings: z.array(z.strictObject({ segmentId: IdSchema, beforeSegmentId: IdSchema.nullable() })),
  rationale: z.string(), unresolvedQuestions: z.array(z.string()), estimatedDurationMs: MsSchema,
}).superRefine((plan, context) => {
  for (const field of ['selectedSegments', 'removedSegments'] as const) {
    if (new Set(plan[field]).size !== plan[field].length) {
      context.addIssue({ code: 'custom', path: [field], message: 'Duplicate segment choice' });
    }
  }
  if (plan.selectedSegments.some(id => plan.removedSegments.includes(id))) {
    context.addIssue({ code: 'custom', message: 'Selections and removals must be disjoint' });
  }
  const successors = new Map<string, string | null>();
  for (const reorder of plan.reorderings) {
    if (successors.has(reorder.segmentId)) {
      context.addIssue({ code: 'custom', path: ['reorderings'], message: 'Ambiguous reordering' });
    }
    successors.set(reorder.segmentId, reorder.beforeSegmentId);
  }
  for (const start of successors.keys()) {
    const visited = new Set<string>();
    let id: string | null | undefined = start;
    while (id != null && successors.has(id)) {
      if (visited.has(id)) {
        context.addIssue({ code: 'custom', path: ['reorderings'], message: 'Cyclic reordering' });
        break;
      }
      visited.add(id);
      id = successors.get(id);
    }
  }
});

export type IntentItem = z.infer<typeof IntentItemSchema>;
export type EditContract = z.infer<typeof EditContractSchema>;
export type EditorialPlan = z.infer<typeof EditorialPlanSchema>;
