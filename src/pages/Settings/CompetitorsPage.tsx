import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Plus, Trash2, Edit2, FileText, Megaphone } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import type { Competitor, CompetitorType } from '@/types';

// The competitor library powers the "pre-trained" feel of the reels and posts
// agents. When the user adds or edits a competitor here, the next agent run
// pulls fresh copies from Supabase — no redeploy needed.
export default function CompetitorsPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const competitors = useAppStore((s) => s.competitors);
  const saveCompetitor = useAppStore((s) => s.saveCompetitor);
  const deleteCompetitor = useAppStore((s) => s.deleteCompetitor);
  const addToast = useAppStore((s) => s.addToast);

  const [activeTab, setActiveTab] = useState<CompetitorType>('reel_script');
  const [editing, setEditing] = useState<Competitor | null>(null);

  const visible = useMemo(
    () => competitors.filter((c) => c.type === activeTab).sort((a, b) => a.name.localeCompare(b.name)),
    [competitors, activeTab],
  );

  const handleSave = async (row: Competitor) => {
    try {
      await saveCompetitor(row);
      addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
      setEditing(null);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(isAr ? 'حذف هذا النموذج؟' : 'Delete this competitor?')) return;
    try {
      await deleteCompetitor(id);
      addToast(isAr ? 'تم الحذف' : 'Deleted', 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-charcoal">
          {isAr ? 'مكتبة المنافسين' : 'Competitor Library'}
        </h1>
        <Button
          onClick={() =>
            setEditing({
              id: uuid(),
              name: '',
              type: activeTab,
              content: '',
              tags: [],
              notes: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
          }
        >
          <Plus size={16} />
          {isAr ? 'إضافة نموذج' : 'Add competitor'}
        </Button>
      </div>
      <p className="text-sm text-charcoal/60 mb-5">
        {isAr
          ? 'يُستخدم هذا المحتوى كمرجع أسلوب فقط للوكلاء — لا يُنسخ نصه في المنشورات أو الريلز.'
          : 'This content is a style reference for the agents only — their output never copies the text.'}
      </p>

      <div className="flex gap-2 mb-5">
        <TabButton
          active={activeTab === 'reel_script'}
          onClick={() => setActiveTab('reel_script')}
          icon={<Megaphone size={14} />}
          label={isAr ? 'نماذج الريلز' : 'Reel scripts'}
        />
        <TabButton
          active={activeTab === 'post_example'}
          onClick={() => setActiveTab('post_example')}
          icon={<FileText size={14} />}
          label={isAr ? 'نماذج المنشورات' : 'Post examples'}
        />
      </div>

      {visible.length === 0 ? (
        <div className="bg-white rounded-xl border border-sand/50 p-10 text-center text-sm text-charcoal/60">
          {isAr ? 'لا توجد نماذج بعد — أضف نموذجاً لتحسين جودة المحتوى.' : 'No competitors yet — add one to sharpen the agent output.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-sand/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-cream/50 border-b border-sand/50">
              <tr>
                <th className="text-start px-4 py-2 text-xs font-bold text-charcoal/60 uppercase">
                  {isAr ? 'الاسم' : 'Name'}
                </th>
                <th className="text-start px-4 py-2 text-xs font-bold text-charcoal/60 uppercase">
                  {isAr ? 'المحتوى' : 'Content'}
                </th>
                <th className="text-start px-4 py-2 text-xs font-bold text-charcoal/60 uppercase">
                  {isAr ? 'الوسوم' : 'Tags'}
                </th>
                <th className="w-[120px]" />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id} className="border-b border-sand/30">
                  <td className="px-4 py-2 font-semibold text-charcoal">{row.name || '—'}</td>
                  <td className="px-4 py-2 text-charcoal/70 max-w-md">
                    <div className="line-clamp-2">{row.content}</div>
                  </td>
                  <td className="px-4 py-2 text-xs text-charcoal/60">{(row.tags ?? []).join(', ')}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => setEditing({ ...row })}
                        className="p-1.5 rounded-md hover:bg-cream text-charcoal/50 hover:text-charcoal"
                        title={isAr ? 'تعديل' : 'Edit'}
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(row.id)}
                        className="p-1.5 rounded-md hover:bg-red-50 text-charcoal/40 hover:text-red-600"
                        title={isAr ? 'حذف' : 'Delete'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditModal
          row={editing}
          isAr={isAr}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
        active ? 'bg-copper text-white' : 'bg-white text-charcoal/70 hover:bg-cream border border-sand/50'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function EditModal({
  row,
  isAr,
  onClose,
  onSave,
}: {
  row: Competitor;
  isAr: boolean;
  onClose: () => void;
  onSave: (row: Competitor) => void;
}) {
  const [draft, setDraft] = useState<Competitor>({ ...row });

  const canSave = !!draft.name.trim() && !!draft.content.trim();

  return (
    <Modal
      open
      onClose={onClose}
      title={isAr ? 'تعديل نموذج منافس' : 'Edit competitor'}
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => onSave({ ...draft, updated_at: new Date().toISOString() })}
          >
            {isAr ? 'حفظ' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={isAr ? 'الاسم' : 'Name'}>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
          />
        </Field>
        <Field label={isAr ? 'المحتوى' : 'Content'}>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            rows={10}
            className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-copper/30"
          />
        </Field>
        <Field label={isAr ? 'الوسوم (مفصولة بفاصلة)' : 'Tags (comma-separated)'}>
          <input
            value={(draft.tags ?? []).join(', ')}
            onChange={(e) =>
              setDraft({
                ...draft,
                tags: e.target.value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
            className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
          />
        </Field>
        <Field label={isAr ? 'ملاحظات' : 'Notes'}>
          <textarea
            value={draft.notes ?? ''}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={2}
            className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-charcoal/70 mb-1">{label}</label>
      {children}
    </div>
  );
}
