import { createHash } from 'node:crypto';
import { ProjectIRSchema } from './project.js';

/** Canonical JSON: sorted object keys; ordered arrays; absent optional fields omitted. */
export function canonicalSerialize(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object' || input === null) throw new TypeError('Expected JSON-compatible content');
    if (ancestors.has(input)) throw new TypeError('Cyclic content is not canonical JSON');
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new TypeError('Expected a plain JSON object');
    }
    if (Object.getOwnPropertySymbols(input).length > 0) throw new TypeError('Symbol keys are not JSON content');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        return '[' + Array.from(input, item => encode(item)).join(',') + ']';
      }
      const object = input as Record<string, unknown>;
      return '{' + Object.keys(object).sort().filter(key => object[key] !== undefined)
        .map(key => JSON.stringify(key) + ':' + encode(object[key])).join(',') + '}';
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}

const compareIds = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Validate and normalize unordered entity collections, without mutating the input. */
export function serializeProjectIR(input: unknown): string {
  const project = ProjectIRSchema.parse(input);
  return canonicalSerialize({
    ...project,
    assets: [...project.assets].sort(compareIds),
    segments: [...project.segments].sort(compareIds),
    sequence: {
      ...project.sequence,
      clips: [...project.sequence.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs || compareIds(a, b)),
    },
  });
}

/** SHA-256 over UTF-8 canonical ProjectIR, never a task/run envelope or host path. */
export function hashProjectIR(input: unknown): string {
  return createHash('sha256').update(serializeProjectIR(input), 'utf8').digest('hex');
}
