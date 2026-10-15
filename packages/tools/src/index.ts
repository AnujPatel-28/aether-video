// Shared agent surface: visible task contracts and tool schemas, identical for every arm.
export { TaskInstructionsSchema, type TaskInstructions } from './task.js';
export {
  DEFAULT_TOOL_LIMITS, TOOL_NAMES, ToolErrorCodeSchema, ToolErrorSchema, ToolInputSchemas, ToolLimitsSchema, ToolNameSchema,
  ToolOutputSchemas,
  type ToolError, type ToolInput, type ToolLimits, type ToolName, type ToolOutput, type ToolResult,
} from './contracts.js';
