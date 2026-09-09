// Entry point for build.mjs: the subset of @actions/workflow-parser that check.mjs needs.
// Bundled into dist/workflow-parser.cjs so the action runs with nothing but the checkout.
export {
  parseWorkflow,
  convertWorkflowTemplate,
  NoOperationTraceWriter,
} from "@actions/workflow-parser";
export { ErrorPolicy } from "@actions/workflow-parser/model/convert";
