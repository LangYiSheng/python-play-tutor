import type { Component } from 'vue';
import type { QuestionKind } from '../../../../../shared/questions';
import ChoiceAnswer from './ChoiceAnswer.vue';
import MultipleChoiceAnswer from './MultipleChoiceAnswer.vue';
import FillAnswer from './FillAnswer.vue';
import ProgrammingQuestion from '../ProgrammingQuestion.vue';
import ProgrammingPaperSummary from '../ProgrammingPaperSummary.vue';

interface QuestionView { input: Component; standalone?: boolean; paper?: Component }
export const questionViews: Record<QuestionKind, QuestionView> = {
  single_choice: { input: ChoiceAnswer },
  multiple_choice: { input: MultipleChoiceAnswer },
  boolean: { input: ChoiceAnswer },
  fill: { input: FillAnswer },
  python: { input: ProgrammingQuestion, standalone: true, paper: ProgrammingPaperSummary },
};
