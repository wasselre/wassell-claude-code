import { useState } from 'react';
import { Layers, Plus, Pencil, Trash2, Check, X, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord } from '@/types';
import {
  readProfiles,
  profileKeys,
  pickProfileValues,
  addProfile,
  switchProfile,
  renameProfile,
  deleteProfile,
  type ProfileMutation,
} from '@/lib/clients/preferenceProfiles';

interface Props {
  /** The client record as held by the store (source of the saved profiles). */
  client: AppRecord;
  /** The rep's live edit buffer (its profile-key values are snapshotted on switch). */
  draft: Record<string, unknown>;
  /** The clients model, to resolve which slugs make up a profile. */
  clientsModel: AppModel;
  /** The version this surface loaded with (optimistic concurrency). */
  expectedVersion: number | null;
  isAr: boolean;
  disabled?: boolean;
  /**
   * Called after a successful profile mutation. `flat` is the new active
   * profile's flat values to merge into the host draft (undefined when the flat
   * slugs did not change — rename / removing a non-active profile).
   * `nextVersion` is the version to pin for the host's next save.
   */
  onApplied: (flat: Record<string, unknown> | undefined, nextVersion: number | null) => void;
}

/**
 * Preference-profile selector — the header control that lets ONE client hold
 * multiple named preference sets (e.g. «شقة استثمار» and «فيلا سكن»), each with
 * its own budget, unit type, area, and geography. The ACTIVE profile's values
 * are the flat top-level slugs every existing reader (Finder, geo gate,
 * assistant, chips) already uses — see `src/lib/clients/preferenceProfiles.ts`.
 *
 * Switching writes the client record (version-aware) and hands the new active
 * values back so the host's edit draft re-syncs. Presentational otherwise.
 */
export default function PreferenceProfileBar({
  client, draft, clientsModel, expectedVersion, isAr, disabled, onApplied,
}: Props) {
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const keys = profileKeys(clientsModel);
  const { profiles, activeId } = readProfiles(client.data, keys, isAr);

  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');

  // Apply a computed mutation: persist the client record, then hand the new flat
  // values + version back to the host. currentValues comes from the DRAFT so
  // unsaved edits are captured into the profile being left.
  const apply = async (mut: ProfileMutation | null) => {
    if (!mut || busy) return;
    setBusy(true);
    const next: AppRecord = {
      ...client,
      data: { ...client.data, ...mut.patch },
      updated_at: new Date().toISOString(),
    };
    const res = await saveRecord(next, { expectedVersion });
    setBusy(false);
    if (res.status === 'conflict') {
      addToast(
        isAr ? 'تم تعديل العميل في مكان آخر — أعد التحميل قبل الحفظ.' : 'Client was edited elsewhere — reload before saving.',
        'error',
      );
      return;
    }
    const nextVersion = res.status === 'saved' && expectedVersion !== null ? expectedVersion + 1 : expectedVersion;
    onApplied(mut.flat, nextVersion);
  };

  const currentValues = () => pickProfileValues(draft, keys);

  const doSwitch = (id: string) => {
    if (id === activeId || disabled) return;
    void apply(switchProfile(client.data, keys, currentValues(), id, isAr));
  };

  const doAdd = () => {
    void apply(addProfile(client.data, keys, currentValues(), newName, isAr));
    setAdding(false);
    setNewName('');
  };

  const doRename = (id: string) => {
    void apply(renameProfile(client.data, keys, currentValues(), id, renameName, isAr));
    setRenamingId(null);
    setRenameName('');
  };

  const doDelete = (id: string) => {
    if (profiles.length <= 1) return;
    void apply(deleteProfile(client.data, keys, currentValues(), id, isAr));
  };

  return (
    <div className="mb-4 rounded-xl border border-sand/40 bg-cream/30 p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Layers size={14} className="text-copper" />
        <span className="text-xs font-bold text-chocolate">{isAr ? 'ملفات التفضيلات' : 'Preference profiles'}</span>
        {busy && <Loader2 size={13} className="animate-spin text-charcoal/40" />}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {profiles.map((p) => {
          const active = p.id === activeId;
          if (renamingId === p.id) {
            return (
              <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-copper bg-white px-2 py-1">
                <input
                  type="text"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') doRename(p.id); if (e.key === 'Escape') setRenamingId(null); }}
                  className="w-32 bg-transparent text-xs font-bold text-charcoal outline-none"
                  autoFocus
                />
                <button type="button" onClick={() => doRename(p.id)} className="text-copper hover:opacity-70" aria-label={isAr ? 'حفظ' : 'save'}>
                  <Check size={13} />
                </button>
                <button type="button" onClick={() => setRenamingId(null)} className="text-charcoal/40 hover:text-charcoal" aria-label={isAr ? 'إلغاء' : 'cancel'}>
                  <X size={13} />
                </button>
              </span>
            );
          }
          return (
            <span
              key={p.id}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold transition"
              style={active ? { backgroundColor: '#B8734F', borderColor: '#B8734F', color: '#fff' } : { backgroundColor: '#fff', borderColor: '#D4B89655', color: '#4A4E54' }}
            >
              <button type="button" onClick={() => doSwitch(p.id)} disabled={disabled || busy} className="disabled:cursor-not-allowed">
                {p.name}
              </button>
              {!disabled && active && (
                <>
                  <button
                    type="button"
                    onClick={() => { setRenamingId(p.id); setRenameName(p.name); }}
                    className="opacity-80 hover:opacity-100"
                    aria-label={isAr ? 'إعادة تسمية' : 'rename'}
                  >
                    <Pencil size={11} />
                  </button>
                  {profiles.length > 1 && (
                    <button
                      type="button"
                      onClick={() => doDelete(p.id)}
                      className="opacity-80 hover:opacity-100"
                      aria-label={isAr ? 'حذف' : 'delete'}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </>
              )}
            </span>
          );
        })}

        {!disabled && (adding ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-copper bg-white px-2 py-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') { setAdding(false); setNewName(''); } }}
              placeholder={isAr ? 'اسم الملف…' : 'Profile name…'}
              className="w-32 bg-transparent text-xs font-bold text-charcoal outline-none placeholder:text-charcoal/30"
              autoFocus
            />
            <button type="button" onClick={doAdd} className="text-copper hover:opacity-70" aria-label={isAr ? 'إضافة' : 'add'}>
              <Check size={13} />
            </button>
            <button type="button" onClick={() => { setAdding(false); setNewName(''); }} className="text-charcoal/40 hover:text-charcoal" aria-label={isAr ? 'إلغاء' : 'cancel'}>
              <X size={13} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-full border border-copper/40 bg-copper/10 px-2.5 py-1 text-xs font-bold text-copper transition hover:bg-copper/20 disabled:opacity-40"
          >
            <Plus size={12} /> {isAr ? 'ملف جديد' : 'New profile'}
          </button>
        ))}
      </div>

      <p className="mt-2 text-[11px] leading-4 text-charcoal/50">
        {isAr
          ? 'لكل ملف تفضيلاته الكاملة (الميزانية، النوع، الموقع…). المطابقة تعمل على الملف النشط.'
          : "Each profile has its own full preferences (budget, type, location…). Matching runs on the active profile."}
      </p>
    </div>
  );
}
