import { readFileSync } from 'node:fs';
import { ProjectIRSchema, KernelSafetyContextSchema } from '@aether/core';
import { TaskInstructionsSchema } from '@aether/tools';
import { EditContractSchema, EditorialPlanSchema } from '@aether/tools/orchestration';
import { EvaluationSpecSchema, ExperimentConfigSchema } from '@aether/verification/evaluator';

// Each load returns fresh data. These are synthetic schema fixtures, not real media/evaluation.
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
}
export const projectFixture = () => ProjectIRSchema.parse(fixture('project'));
export const taskFixture = () => TaskInstructionsSchema.parse(fixture('task'));
export const safetyFixture = () => KernelSafetyContextSchema.parse(fixture('safety'));
export const contractFixture = () => EditContractSchema.parse(fixture('contract'));
export const planFixture = () => EditorialPlanSchema.parse(fixture('plan'));
export const evaluationFixture = () => EvaluationSpecSchema.parse(fixture('evaluation'));
export const configFixture = () => ExperimentConfigSchema.parse(fixture('config'));
