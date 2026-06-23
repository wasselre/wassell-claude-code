import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileStack, MoreVertical, ChevronDown, ChevronRight, Check, X, Trash2, FolderInput, Pencil,
  CheckCircle2, AlertCircle, Loader2, Clock,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord } from '@/types';
import { readMigrationData, type MigrationStatus } from '../lib/types';
import type { MigrationJob } from '../lib/jobRunner';

interface MigrationListProps {
  isAr: boolean;
  migrations: AppRecord[]; // already sorted newest-first
  models: AppModel[];
  modelId: string; // data_migration model id
  activeId?: string;
  jobs: Record<string, MigrationJob>;
  onOpen: (id: string) => void;
}

const UNGROUPED = '__ungrouped__';

/**
 * The Data Migration sidebar list. Beyond opening a migration, it supports
 * managing them: rename (title), move into a named group, rename a group
 * (updates all its members), collapse groups, and delete. All edits go through
 * `saveRecord` / `deleteRecord` with the single-writer `expectedVersion: null`
 * posture the wizard uses (a migration is one record edited by one tab).
 */
export default function MigrationList({
  isAr, migrations, models, modelId, activeId, jobs, onOpen,
}: MigrationListProps) {
  const saveRecord = useAppStore((s) => s.saveRecord);
  const deleteRecord = useAppStore((s) => s.deleteRecord);

  const [menuId, setMenuId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingGroup, setEditingGroup] = useState<string | null>(null);

  // All existing group names (for the move-to-group datalist).
  const allGroups = useMemo(() => {
    const set = new Set<string>();
    for (const m of migrations) {
      const g = (readMigrationData(m).group ?? '').trim();
      if (g) set.add(g);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [migrations]);

  // Group migrations; named groups first (alpha), Ungrouped last.
  const sections = useMemo(() => {
    const map = new Map<string, AppRecord[]>();
    for (const m of migrations) {
      const g = (readMigrationData(m).group ?? '').trim() || UNGROUPED;
      const list = map.get(g) ?? [];
      list.push(m);
      map.set(g, list);
    }
    const named = [...map.keys()].filter((k) => k !== UNGROUPED).sort((a, b) => a.localeCompare(b));
    const order = [...named, ...(map.has(UNGROUPED) ? [UNGROUPED] : [])];
    return order.map((key) => ({ key, items: map.get(key)! }));
  }, [migrations]);

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const patchRecord = (rec: AppRecord, partial: Record<string, unknown>) => {
    void saveRecord(
      { ...rec, data: { ...rec.data, ...partial }, updated_at: new Date().toISOString() },
      { expectedVersion: null },
    );
  };

  const renameGroupTo = (oldName: string, rawNext: string) => {
    const next = rawNext.trim();
    setEditingGroup(null);
    if (!next || next === oldName) return;
    for (const m of migrations) {
      if ((readMigrationData(m).group ?? '').trim() === oldName) patchRecord(m, { group: next });
    }
  };

  const removeMigration = (rec: AppRecord) => {
    const title = (readMigrationData(rec).title ?? '').trim() || (isAr ? 'بدون عنوان' : 'Untitled migration');
    const msg = isAr ? `حذف عملية الترحيل "${title}"؟ لا يمكن التراجع.` : `Delete migration "${title}"? This can't be undone.`;
    if (!window.confirm(msg)) return;
    setMenuId(null);
    deleteRecord(modelId, rec.id);
  };

  if (migrations.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-charcoal/60">
        {isAr ? 'لا توجد عمليات ترحيل بعد.' : 'No migrations yet.'}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {sections.map(({ key, items }) => {
        const isUngrouped = key === UNGROUPED;
        const groupLabel = isUngrouped ? (isAr ? 'بدون مجموعة' : 'Ungrouped') : key;
        const isOpen = !collapsed.has(key);
        return (
          <div key={key}>
            {/* Group header */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-cream-light/60 border-b border-sand/10 sticky top-0 z-[1]">
              <button onClick={() => toggleCollapse(key)} className="p-0.5 text-charcoal/40 hover:text-charcoal/70">
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              {editingGroup === key && !isUngrouped ? (
                <GroupRenameInput initial={key} isAr={isAr} onCommit={(v) => renameGroupTo(key, v)} onCancel={() => setEditingGroup(null)} />
              ) : (
                <button
                  onClick={() => toggleCollapse(key)}
                  className="flex-1 min-w-0 text-start text-[11px] font-bold uppercase tracking-wide text-charcoal/55 truncate"
                >
                  {groupLabel}
                  <span className="text-charcoal/35 font-normal"> · {items.length}</span>
                </button>
              )}
              {!isUngrouped && editingGroup !== key && (
                <button
                  onClick={() => setEditingGroup(key)}
                  title={isAr ? 'إعادة تسمية المجموعة' : 'Rename group'}
                  className="p-1 text-charcoal/30 hover:text-copper opacity-0 group-hover:opacity-100"
                >
                  <Pencil size={12} />
                </button>
              )}
            </div>

            {/* Rows */}
            {isOpen && items.map((mig) => {
              const d = readMigrationData(mig);
              const title = (d.title ?? '').trim() || (isAr ? 'بدون عنوان' : 'Untitled migration');
              const status: MigrationStatus = d.status ?? 'draft';
              const targetModel = d.target_model_id ? models.find((m) => m.id === d.target_model_id) : undefined;
              const subtitle = targetModel ? (isAr ? targetModel.label_ar : targetModel.label_en) : null;
              const active = mig.id === activeId;
              const job = jobs[mig.id];
              return (
                <div
                  key={mig.id}
                  className={`group relative border-b border-sand/10 ${active ? 'bg-cream' : 'hover:bg-cream'}`}
                >
                  <button onClick={() => onOpen(mig.id)} className="w-full text-start p-3 pe-9">
                    <div className="flex items-center gap-2">
                      <FileStack size={14} className="text-copper shrink-0" />
                      <div className="font-medium text-sm truncate flex-1">{title}</div>
                      <MigrationStatusPill status={status} isAr={isAr} />
                    </div>
                    {subtitle && (
                      <div className="text-xs text-charcoal/50 truncate mt-1 ps-6">
                        {isAr ? `إلى: ${subtitle}` : `Into: ${subtitle}`}
                      </div>
                    )}
                    {job?.kind === 'migrate' && job.total > 0 && (
                      <div className="mt-1.5 ps-6 flex items-center gap-2">
                        <div className="h-1 flex-1 rounded-full bg-sand/30 overflow-hidden">
                          <div className="h-full bg-copper transition-all" style={{ width: `${Math.round((job.done / job.total) * 100)}%` }} />
                        </div>
                        <span className="text-[10px] text-charcoal/50 tabular-nums shrink-0">{job.done}/{job.total}</span>
                      </div>
                    )}
                    {/* Worker extraction progress (records-mode fusion) — driven
                        by the record's phase/progress, live via Realtime. */}
                    {status === 'extracting' && d.phase === 'fusing' && (d.progress_total ?? 0) > 0 && (
                      <div className="mt-1.5 ps-6 flex items-center gap-2">
                        <div className="h-1 flex-1 rounded-full bg-sand/30 overflow-hidden">
                          <div
                            className="h-full bg-copper transition-all"
                            style={{ width: `${Math.round(((d.progress_done ?? 0) / (d.progress_total || 1)) * 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-charcoal/50 tabular-nums shrink-0">
                          {d.progress_done ?? 0}/{d.progress_total}
                        </span>
                      </div>
                    )}
                  </button>

                  {/* Kebab — edit/move/delete */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuId((id) => (id === mig.id ? null : mig.id)); }}
                    title={isAr ? 'خيارات' : 'Options'}
                    className="absolute top-2 end-1.5 p-1.5 rounded-lg text-charcoal/35 hover:bg-sand/20 hover:text-charcoal/70"
                  >
                    <MoreVertical size={15} />
                  </button>

                  {menuId === mig.id && (
                    <EditPopover
                      isAr={isAr}
                      record={mig}
                      groups={allGroups}
                      onClose={() => setMenuId(null)}
                      onSave={(title2, group2) => { patchRecord(mig, { title: title2, group: group2 || undefined }); setMenuId(null); }}
                      onDelete={() => removeMigration(mig)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Inline group-name editor. */
function GroupRenameInput({ initial, isAr, onCommit, onCancel }: {
  initial: string; isAr: boolean; onCommit: (v: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="flex-1 flex items-center gap-1">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onCommit(text); if (e.key === 'Escape') onCancel(); }}
        className="form-input text-xs py-0.5 flex-1"
        placeholder={isAr ? 'اسم المجموعة' : 'Group name'}
      />
      <button onClick={() => onCommit(text)} className="p-1 text-green-600 hover:bg-green-50 rounded"><Check size={13} /></button>
      <button onClick={onCancel} className="p-1 text-charcoal/40 hover:bg-sand/20 rounded"><X size={13} /></button>
    </div>
  );
}

/** Per-migration edit popover: rename title, move to group (datalist of existing
 * groups; type a new one), and delete. */
function EditPopover({ isAr, record, groups, onClose, onSave, onDelete }: {
  isAr: boolean;
  record: AppRecord;
  groups: string[];
  onClose: () => void;
  onSave: (title: string, group: string) => void;
  onDelete: () => void;
}) {
  const d = readMigrationData(record);
  const [title, setTitle] = useState((d.title ?? '').trim());
  const [group, setGroup] = useState((d.group ?? '').trim());
  const ref = useRef<HTMLDivElement>(null);
  const listId = `mig-groups-${record.id}`;

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute top-9 end-1.5 z-30 w-60 rounded-xl border border-sand/40 bg-white shadow-lg p-3 space-y-2">
      <div>
        <label className="block text-[10px] font-bold text-charcoal/45 mb-1">{isAr ? 'العنوان' : 'Title'}</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSave(title, group); }}
          className="form-input text-sm py-1 w-full"
          placeholder={isAr ? 'عنوان الترحيل' : 'Migration title'}
        />
      </div>
      <div>
        <label className="flex items-center gap-1 text-[10px] font-bold text-charcoal/45 mb-1">
          <FolderInput size={11} /> {isAr ? 'المجموعة' : 'Group'}
        </label>
        <input
          list={listId}
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSave(title, group); }}
          className="form-input text-sm py-1 w-full"
          placeholder={isAr ? 'بدون مجموعة' : 'Ungrouped'}
        />
        <datalist id={listId}>
          {groups.map((g) => <option key={g} value={g} />)}
        </datalist>
      </div>
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1 text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded-lg"
        >
          <Trash2 size={13} /> {isAr ? 'حذف' : 'Delete'}
        </button>
        <button
          onClick={() => onSave(title, group)}
          className="inline-flex items-center gap-1 text-xs font-bold bg-copper text-white hover:bg-terracotta px-3 py-1 rounded-lg"
        >
          <Check size={13} /> {isAr ? 'حفظ' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function MigrationStatusPill({ status, isAr }: { status: MigrationStatus; isAr: boolean }) {
  const config: Record<MigrationStatus, { ar: string; en: string; bg: string; fg: string; Icon: typeof Clock }> = {
    draft: { ar: 'مسودة', en: 'Draft', bg: 'bg-charcoal/10', fg: 'text-charcoal/70', Icon: Clock },
    extracting: { ar: 'استخراج', en: 'Extracting', bg: 'bg-blue-100', fg: 'text-blue-700', Icon: Loader2 },
    migrating: { ar: 'ترحيل', en: 'Migrating', bg: 'bg-blue-100', fg: 'text-blue-700', Icon: Loader2 },
    done: { ar: 'تم', en: 'Done', bg: 'bg-green-100', fg: 'text-green-700', Icon: CheckCircle2 },
    failed: { ar: 'فشل', en: 'Failed', bg: 'bg-red-100', fg: 'text-red-700', Icon: AlertCircle },
    undoing: { ar: 'تراجع', en: 'Undoing', bg: 'bg-blue-100', fg: 'text-blue-700', Icon: Loader2 },
  };
  const c = config[status];
  const { Icon } = c;
  const spinning = status === 'extracting' || status === 'migrating' || status === 'undoing';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${c.bg} ${c.fg} shrink-0`}>
      <Icon size={10} className={spinning ? 'animate-spin' : ''} />
      {isAr ? c.ar : c.en}
    </span>
  );
}
