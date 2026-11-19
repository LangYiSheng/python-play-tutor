import { questionKindLabels, type QuestionKind } from "../../../../shared/questions";
import type { QuestionOutlineState } from "../../shared/types";

export interface QuestionOutlineItem {
  id: string;
  index?: number;
  title: string;
  kind?: QuestionKind;
  state?: QuestionOutlineState;
  current?: boolean;
}

export const questionStateLabel = { unanswered: "未作答", answered: "已作答", accepted: "正确", wrong: "错误", pending: "判定中" };
export const questionKindLabel = { ...questionKindLabels, unknown: "题目" };
