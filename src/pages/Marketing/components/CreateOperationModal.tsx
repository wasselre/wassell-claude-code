import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import {
  REEL_TYPES,
  REEL_PLATFORMS,
  REEL_VOICEOVERS,
  POST_TYPES,
  POST_USAGES,
  type ReelType,
  type ReelPlatform,
  type ReelVoiceover,
  type PostType,
  type PostUsage,
} from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function CreateOperationModal({ open, onClose }: Props) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);
  const createMarketingOperation = useAppStore((s) => s.createMarketingOperation);

  const allProjectsModel = useMemo(
    () => models.find((m) => m.name === 'all_projects'),
    [models],
  );
  const projects = useMemo(
    () => (allProjectsModel ? recordsByModel[allProjectsModel.id] ?? [] : []),
    [allProjectsModel, recordsByModel],
  );

  const [projectId, setProjectId] = useState<string>('');
  const [includeReels, setIncludeReels] = useState(true);
  const [reelsCount, setReelsCount] = useState(3);
  const [reelType, setReelType] = useState<ReelType>('ترويجي');
  const [reelPlatform, setReelPlatform] = useState<ReelPlatform>('حسابات');
  const [reelVoice, setReelVoice] = useState<ReelVoiceover>('رجل');

  const [includePosts, setIncludePosts] = useState(true);
  const [postsCount, setPostsCount] = useState(3);
  const [postType, setPostType] = useState<PostType>('توعية');
  const [postUsage, setPostUsage] = useState<PostUsage>('الحسابات');

  const [submitting, setSubmitting] = useState(false);

  const canSubmit = !!projectId && (includeReels || includePosts) && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const id = await createMarketingOperation({
        projectRecordId: projectId,
        reelsSettings: includeReels
          ? { count: reelsCount, type: reelType, platform: reelPlatform, voiceover: reelVoice }
          : null,
        postsSettings: includePosts
          ? { count: postsCount, type: postType, usage: postUsage }
          : null,
      });
      addToast(isAr ? 'تم بدء العملية — جاري البحث عن المشروع' : 'Operation started — researching the project', 'success');
      onClose();
      navigate(`/marketing/${id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAr ? 'عملية تسويقية جديدة' : 'New Marketing Operation'}
      maxWidth="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting
              ? (isAr ? 'جاري الإرسال…' : 'Submitting…')
              : (isAr ? 'ابدأ' : 'Start')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-bold text-charcoal mb-1.5">
            {isAr ? 'المشروع' : 'Project'}
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
          >
            <option value="">{isAr ? 'اختر مشروعاً…' : 'Select a project…'}</option>
            {projects.map((p) => {
              const name =
                (p.data.project_name as string | undefined) ??
                (p.data.name as string | undefined) ??
                p.id;
              return (
                <option key={p.id} value={p.id}>
                  {name}
                </option>
              );
            })}
          </select>
          {projects.length === 0 && (
            <p className="mt-1 text-xs text-charcoal/50">
              {isAr ? 'لا توجد مشاريع. أضف أحد المشاريع في "جميع المشاريع" أولاً.' : 'No projects yet. Add one in "All Projects" first.'}
            </p>
          )}
        </div>

        <div className="border border-sand/50 rounded-xl p-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeReels}
              onChange={(e) => setIncludeReels(e.target.checked)}
              className="w-4 h-4 accent-copper"
            />
            <span className="font-bold text-charcoal">
              {isAr ? 'إنشاء ريلز' : 'Include reels'}
            </span>
          </label>
          {includeReels && (
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Field label={isAr ? 'العدد' : 'Count'}>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={reelsCount}
                  onChange={(e) => setReelsCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper/30"
                />
              </Field>
              <Field label={isAr ? 'نوع الريل' : 'Reel type'}>
                <select
                  value={reelType}
                  onChange={(e) => setReelType(e.target.value as ReelType)}
                  className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper/30"
                >
                  {REEL_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
              <Field label={isAr ? 'منصة الاستخدام' : 'Platform'}>
                <select
                  value={reelPlatform}
                  onChange={(e) => setReelPlatform(e.target.value as ReelPlatform)}
                  className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper/30"
                >
                  {REEL_PLATFORMS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
              <Field label={isAr ? 'التعليق الصوتي' : 'Voiceover'}>
                <select
                  value={reelVoice}
                  onChange={(e) => setReelVoice(e.target.value as ReelVoiceover)}
                  className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper/30"
                >
                  {REEL_VOICEOVERS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
            </div>
          )}
        </div>

        <div className="border border-sand/50 rounded-xl p-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includePosts}
              onChange={(e) => setIncludePosts(e.target.checked)}
              className="w-4 h-4 accent-copper"
            />
            <span className="font-bold text-charcoal">
              {isAr ? 'إنشاء منشورات' : 'Include posts'}
            </span>
          </label>
          {includePosts && (
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Field label={isAr ? 'العدد' : 'Count'}>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={postsCount}
                  onChange={(e) => setPostsCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper/30"
                />
              </Field>
              <Field label={isAr ? 'نوع المنشور' : 'Post type'}>
                <select
                  value={postType}
                  onChange={(e) => setPostType(e.target.value as PostType)}
                  className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper/30"
                >
                  {POST_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
              <Field label={isAr ? 'الاستخدام' : 'Usage'}>
                <select
                  value={postUsage}
                  onChange={(e) => setPostUsage(e.target.value as PostUsage)}
                  className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper/30"
                >
                  {POST_USAGES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
            </div>
          )}
        </div>

        {!includeReels && !includePosts && (
          <p className="text-xs text-red-600">
            {isAr ? 'يجب اختيار نوع محتوى واحد على الأقل.' : 'Pick at least one content type.'}
          </p>
        )}
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
