// Trusted agent-side runtime. This entry must never reach the evaluator or diagnostics (see ./evaluation).
export { createToolHost, type SubmissionRecord, type ToolHost, type ToolHostOptions } from './host.js';
