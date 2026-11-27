export { questionKindLabels as kinds } from "../../../../shared/questions";
export {
  codingTypeLabels,
  codingUsageLabels,
  type CodingType,
  type CodingUsage,
} from "../../../../shared/codingQuestions";
export const statuses = { draft: "待审核", ready: "可用", disabled: "停用" };
export type Case = { input: string; expected_output: string };
