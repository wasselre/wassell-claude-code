import { useNavigate } from 'react-router-dom';
import { Bot, MessageCircle, User, Building2, Clock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AgentQuestion } from '@/types';
import AgentQuestionItem from '@/components/agentQuestions/AgentQuestionItem';

function waitedLabel(createdAt: string, isAr: boolean, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(createdAt)) / 60_000));
  if (mins < 1) return isAr ? 'الآن' : 'just now';
  if (mins < 60) return isAr ? `منذ ${mins} دقيقة` : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return isAr ? `منذ ${hours} ساعة` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return isAr ? `منذ ${days} يوم` : `${days} d ago`;
}

/**
 * Sales → Work Queue → «أسئلة المساعد»: every open question the WhatsApp sales
 * agent could not answer, in one list, oldest first (the longest-waiting
 * customer on top). Each is answered right here — no need to open the chat.
 */
export default function AgentQuestionsSection({ questions, loading, error, isAr, showRep, onResolved, onStale }: {
  questions: AgentQuestion[];
  loading: boolean;
  error: string | null;
  isAr: boolean;
  /** Name the rep on each card (manager «all reps» view). */
  showRep: boolean;
  onResolved: (id: string) => void;
  onStale: () => void;
}) {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const now = Date.now();

  const clientsModel = models.find((m) => m.name === 'clients');
  const projectsModel = models.find((m) => m.name === 'all_projects');
  const clientName = (id: string | null): string | null => {
    if (!id || !clientsModel) return null;
    const v = (records[clientsModel.id] ?? []).find((r) => r.id === id)?.data.client_name;
    return typeof v === 'string' && v.trim() ? v : null;
  };
  const projectName = (id: string | null): string | null => {
    if (!id || !projectsModel) return null;
    const d = (records[projectsModel.id] ?? []).find((r) => r.id === id)?.data;
    const v = d?.project_name ?? d?.name;
    return typeof v === 'string' && v.trim() ? v : null;
  };
  const repName = (id: string | null): string => {
    if (!id) return isAr ? 'بدون مندوب' : 'No rep';
    const u = users.find((x) => x.id === id);
    return u ? (isAr ? u.name_ar : u.name_en) || u.email || '' : '';
  };

  return (
    <>
      <p className="mb-4 text-xs text-charcoal/60">
        {isAr
          ? 'أسئلة لم يعرف المساعد جوابها وسألك عنها. اكتب الجواب هنا والمساعد يبلّغه للعميل بأسلوبه، أو أغلق السؤال إذا رددت بنفسك.'
          : 'Questions the AI could not answer and asked you. Type the answer here and the AI passes it on in its own voice, or close it if you answered yourself.'}
      </p>
      {error && (
        <p className="mb-3 rounded-xl bg-terracotta/10 p-3 text-sm text-terracotta">
          {isAr ? `تعذّر تحميل الأسئلة: ${error}` : `Could not load the questions: ${error}`}
        </p>
      )}
      {loading && questions.length === 0 ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</p>
      ) : questions.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-copper/10 text-copper">
            <Bot size={24} />
          </span>
          <h2 className="text-lg font-bold text-chocolate">{isAr ? 'لا توجد أسئلة معلّقة' : 'No open questions'}</h2>
          <p className="max-w-md text-sm text-charcoal/60">
            {isAr ? 'عندما يسأل العميل شيئاً لا يعرفه المساعد، يظهر السؤال هنا لتجيب عليه.' : 'When a customer asks something the AI does not know, the question appears here for you to answer.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {questions.map((q) => {
            const client = clientName(q.client_id);
            const project = projectName(q.project_id);
            return (
              <li key={q.id}>
                <AgentQuestionItem
                  question={q}
                  isAr={isAr}
                  onResolved={onResolved}
                  onStale={onStale}
                  context={(
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-charcoal/70">
                      <span className="inline-flex items-center gap-1 font-semibold text-chocolate">
                        <User size={12} /> {client ?? <span dir="ltr">+{q.chat_wid.split('@')[0]}</span>}
                      </span>
                      {project && (
                        <span className="inline-flex items-center gap-1"><Building2 size={12} /> {project}</span>
                      )}
                      <span className="inline-flex items-center gap-1"><Clock size={12} /> {waitedLabel(q.created_at, isAr, now)}</span>
                      {showRep && <span className="text-charcoal/50">{repName(q.rep_user_id)}</span>}
                      {q.conversation_record_id && (
                        <button
                          type="button"
                          onClick={() => navigate(`/model/chats/${q.conversation_record_id}`)}
                          className="ms-auto inline-flex items-center gap-1 rounded-lg bg-[#25D366] px-2.5 py-1 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
                        >
                          <MessageCircle size={12} /> {isAr ? 'فتح المحادثة' : 'Open chat'}
                        </button>
                      )}
                    </div>
                  )}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
