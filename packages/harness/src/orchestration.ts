import { EditContractSchema, EditorialPlanSchema } from '@aether/tools/orchestration';
import type { EditContract, EditorialPlan } from '@aether/tools/orchestration';
import type { ProjectStore } from '@aether/workspace';

// Trusted AETHER artifact slot (G6). Never a shared tool; the evaluator never reads it.

export type OrchestrationResult = { ok: true } | { ok: false; code: 'invalid_artifact' | 'stale_plan' | 'task_mismatch' | 'store_error' };

export async function writeContract(store: ProjectStore, workspaceId: string, input: unknown): Promise<OrchestrationResult> {
  const contract = EditContractSchema.safeParse(input);
  if (!contract.success) return { ok: false, code: 'invalid_artifact' };
  const task = await store.readTask(workspaceId);
  if (!task.ok) return { ok: false, code: 'store_error' };
  if (contract.data.taskId !== task.task.id) return { ok: false, code: 'task_mismatch' };
  return (await store.writeOrchestrationArtifact(workspaceId, 'contract', contract.data)).ok ? { ok: true } : { ok: false, code: 'store_error' };
}

/** A plan must be based on the workspace's current head, so it cannot describe a different state. */
export async function writePlan(store: ProjectStore, workspaceId: string, input: unknown): Promise<OrchestrationResult> {
  const plan = EditorialPlanSchema.safeParse(input);
  if (!plan.success) return { ok: false, code: 'invalid_artifact' };
  const current = await store.readWorkspace(workspaceId);
  if (!current.ok) return { ok: false, code: 'store_error' };
  if (plan.data.baseContentHash !== current.workspace.head.contentHash) return { ok: false, code: 'stale_plan' };
  return (await store.writeOrchestrationArtifact(workspaceId, 'plan', plan.data)).ok ? { ok: true } : { ok: false, code: 'store_error' };
}

export async function readContract(store: ProjectStore, workspaceId: string): Promise<EditContract | undefined> {
  const result = await store.readOrchestrationArtifact(workspaceId, 'contract');
  return result.ok && result.value !== undefined ? EditContractSchema.parse(result.value) : undefined;
}
export async function readPlan(store: ProjectStore, workspaceId: string): Promise<EditorialPlan | undefined> {
  const result = await store.readOrchestrationArtifact(workspaceId, 'plan');
  return result.ok && result.value !== undefined ? EditorialPlanSchema.parse(result.value) : undefined;
}
