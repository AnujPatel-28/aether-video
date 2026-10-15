import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalSerialize } from '@aether/core';
import { MechanicalVerificationResultSchema } from '@aether/verification';
import type { MechanicalVerificationResult } from '@aether/verification';
import { diagnose, DIAGNOSTICS_VERSION } from '@aether/verification/diagnostics';
import { EVALUATOR_VERSION, EvaluationSpecSchema, evaluateSubmission } from '@aether/verification/evaluator';
import type { EditorialVerificationResult, EvaluationSpec } from '@aether/verification/evaluator';
import { StoreSegmentSchema } from '@aether/workspace';
import type { ProjectStore, StoreResult } from '@aether/workspace';

// Trusted offline evaluation (F7–F9). Never imported by the agent-side entry.

export interface EvaluationSubmission {
  /** Blind label; never the arm name. */
  submissionId: string;
  workspaceId: string;
  outcome: 'submitted' | 'budget_exhausted' | 'timeout';
}
export interface SubmissionResult {
  submissionId: string;
  contentHash: string;
  outcome: EvaluationSubmission['outcome'];
  deliveredDurationUs: number | null;
  editorial: EditorialVerificationResult[];
  mechanical: MechanicalVerificationResult[];
}
export interface EvaluationResults {
  schemaVersion: 1;
  runId: string;
  evaluator: string;
  specId: string;
  submissions: SubmissionResult[];
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function unwrap<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`Store error: ${result.error.code}`);
  return result;
}
function runDirectory(evaluationRoot: string, runId: string): string {
  if (!StoreSegmentSchema.safeParse(runId).success) throw new Error('Invalid run ID');
  return join(evaluationRoot, runId);
}

/**
 * Grade frozen submissions. Reads only each frozen head, its delivery render and the hidden spec:
 * never traces, notes, plans, dialogue or arm identity. Results are written once and hashed.
 */
export async function runEvaluation(options: {
  evaluationRoot: string; runId: string; store: ProjectStore; spec: EvaluationSpec; submissions: EvaluationSubmission[];
}): Promise<{ results: EvaluationResults; resultsHash: string }> {
  const spec = EvaluationSpecSchema.parse(options.spec);
  const directory = runDirectory(options.evaluationRoot, options.runId);
  const ordered = [...options.submissions].sort((a, b) => (a.submissionId < b.submissionId ? -1 : 1));
  const heads = [];
  for (const submission of ordered) {
    const { workspace, project } = unwrap(await options.store.readWorkspace(submission.workspaceId));
    if (workspace.state !== 'frozen' || !workspace.submission) throw new Error('Every submission must be frozen before evaluation');
    heads.push({ submission, project, contentHash: workspace.submission.contentHash });
  }
  const submissions: SubmissionResult[] = [];
  for (const { submission, project, contentHash } of heads) {
    const rendered = await options.store.renderPreview(submission.workspaceId, { contentHash, preset: 'delivery-h264-v1' });
    const deliveredDurationUs = rendered.ok ? rendered.manifest.measured.videoDurationUs : null;
    const mechanical = rendered.ok ? rendered.manifest.checks.map(check => MechanicalVerificationResultSchema.parse({
      schemaVersion: 1, checkId: `timing:${check.checkId}`, kind: 'deterministic', status: check.status,
      evidence: [{ message: `expected ${check.expected}, measured ${check.measured}, tolerance ${check.tolerance}`, artifactId: rendered.manifest.artifactId }],
      evaluatedContentHash: contentHash, scope: 'mechanical',
    })) : [];
    submissions.push({
      submissionId: submission.submissionId, contentHash, outcome: submission.outcome, deliveredDurationUs,
      editorial: evaluateSubmission(spec, { contentHash, project, deliveredDurationUs }), mechanical,
    });
  }
  const results: EvaluationResults = { schemaVersion: 1, runId: options.runId, evaluator: EVALUATOR_VERSION, specId: spec.id, submissions };
  const text = canonicalSerialize(results) + '\n';
  const resultsHash = sha256(text);
  await mkdir(directory, { recursive: true });
  // Frozen once: an existing results file is never overwritten.
  await writeFile(join(directory, 'results.json'), text, { encoding: 'utf8', flag: 'wx' });
  await writeFile(join(directory, 'results.sha256'), resultsHash + '\n', { encoding: 'utf8', flag: 'wx' });
  return { results, resultsHash };
}

/** Post-freeze failure-stage diagnostics (Proposal 001 P1). Requires intact frozen results; writes a separate file. */
export async function runDiagnostics(options: {
  evaluationRoot: string; runId: string; store: ProjectStore; spec: EvaluationSpec;
  submissions: { submissionId: string; workspaceId: string; planSelectedSegmentIds?: string[] }[];
}): Promise<{ diagnostics: unknown }> {
  const directory = runDirectory(options.evaluationRoot, options.runId);
  const text = await readFile(join(directory, 'results.json'), 'utf8');
  const recorded = (await readFile(join(directory, 'results.sha256'), 'utf8')).trim();
  if (sha256(text) !== recorded) throw new Error('Frozen results do not match their hash');
  const results = JSON.parse(text) as EvaluationResults;
  const entries = [];
  for (const submission of [...options.submissions].sort((a, b) => (a.submissionId < b.submissionId ? -1 : 1))) {
    const frozen = results.submissions.find(item => item.submissionId === submission.submissionId);
    if (!frozen) throw new Error('Submission has no frozen result');
    const { events } = unwrap(await options.store.readToolTrace(submission.workspaceId));
    const { notes } = unwrap(await options.store.readNotes(submission.workspaceId));
    const { project } = unwrap(await options.store.readWorkspace(submission.workspaceId));
    const { stages } = diagnose({
      spec: options.spec, results: frozen.editorial, trace: events, notesText: notes.text, segments: project.segments,
      ...(submission.planSelectedSegmentIds ? { planSelectedSegmentIds: submission.planSelectedSegmentIds } : {}),
    });
    entries.push({ submissionId: submission.submissionId, stages });
  }
  const diagnostics = { schemaVersion: 1, runId: options.runId, rules: DIAGNOSTICS_VERSION, submissions: entries };
  await writeFile(join(directory, 'diagnostics.json'), canonicalSerialize(diagnostics) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { diagnostics };
}

// ---- Milestone 6: trusted run manifest (G3). Written under the evaluation root, never under projects/. ----

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RunManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string(),
  project: z.strictObject({ projectId: z.string(), sourceHash: Hash, transcriptHash: Hash, initialContentHash: Hash }),
  taskHash: Hash, safetyHash: Hash, toolLimitsHash: Hash,
  versions: z.strictObject({ tools: z.string(), evaluator: z.string(), diagnostics: z.string() }),
  render: z.strictObject({ presets: z.array(z.string()), binaries: z.strictObject({ ffmpeg: z.string(), ffprobe: z.string() }) }),
  model: z.strictObject({ provider: z.string(), modelId: z.string(), version: z.string() }),
  sampling: z.record(z.string(), z.json()),
  promptRule: z.string().min(1),
  // Trusted-only: kept apart from submissions so grading stays blind.
  conditions: z.array(z.strictObject({ submissionId: z.string(), workspaceId: z.string(), arm: z.string() })),
  specHash: Hash,
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const hashJson = (value: unknown) => sha256(canonicalSerialize(value));

export async function writeRunManifest(evaluationRoot: string, manifest: RunManifest): Promise<string> {
  const value = RunManifestSchema.parse(manifest);
  const directory = runDirectory(evaluationRoot, value.runId);
  await mkdir(directory, { recursive: true });
  const text = canonicalSerialize(value) + '\n';
  await writeFile(join(directory, 'manifest.json'), text, { encoding: 'utf8', flag: 'wx' });
  return sha256(text);
}
