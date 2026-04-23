import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { ResearchQuestion } from '@/types';

interface Props {
  operationId: string;
}

export default function ResearchQuestionsPanel({ operationId }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const researchQuestions = useAppStore((s) => s.researchQuestions);
  const answerResearchQuestion = useAppStore((s) => s.answerResearchQuestion);
  const addToast = useAppStore((s) => s.addToast);

  const questions = useMemo(
    () =>
      [...researchQuestions]
        .filter((q) => q.operation_id === operationId)
        .sort((a, b) => a.question_number - b.question_number),
    [researchQuestions, operationId],
  );

  if (questions.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-gold/30 p-5">
      <h3 className="font-bold text-charcoal mb-1">
        {isAr ? 'أسئلة البحث' : 'Research Questions'}
      </h3>
      <p className="text-sm text-charcoal/60 mb-4">
        {isAr
          ? 'وُجدت تعارضات بين المصادر. أجب على كل سؤال وستستأنف العملية تلقائياً بعد آخر إجابة.'
          : 'The research agent found conflicts between sources. Answer each question — the operation resumes automatically after the last answer.'}
      </p>
      <div className="space-y-4">
        {questions.map((q) => (
          <QuestionRow
            key={q.id}
            question={q}
            isAr={isAr}
            onSave={async (answer) => {
              try {
                await answerResearchQuestion(q.id, answer);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                addToast(msg, 'error');
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionRow({
  question,
  isAr,
  onSave,
}: {
  question: ResearchQuestion;
  isAr: boolean;
  onSave: (answer: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(question.answer ?? '');
  const [saving, setSaving] = useState(false);
  const answered = question.status === 'answered';

  const handleSave = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      await onSave(draft.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`rounded-lg p-4 border ${
        answered ? 'bg-cream/30 border-sand/50' : 'bg-gold/5 border-gold/30'
      }`}
    >
      <div className="text-sm font-semibold text-charcoal mb-1.5">
        {isAr ? 'السؤال' : 'Question'} #{question.question_number}: {question.question}
      </div>
      {question.source_conflict && (
        <div className="text-xs text-charcoal/60 mb-2">
          {isAr ? 'التعارض' : 'Conflict'}: {question.source_conflict}
        </div>
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={answered}
        rows={2}
        placeholder={isAr ? 'الإجابة…' : 'Your answer…'}
        className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30 disabled:bg-charcoal/5 disabled:text-charcoal/50"
      />
      {!answered && (
        <div className="mt-2 flex justify-end">
          <Button
            onClick={handleSave}
            disabled={!draft.trim() || saving}
            variant="primary"
            className="py-1.5 px-4 text-xs"
          >
            {saving
              ? (isAr ? 'جاري الحفظ…' : 'Saving…')
              : (isAr ? 'حفظ' : 'Save')}
          </Button>
        </div>
      )}
    </div>
  );
}
