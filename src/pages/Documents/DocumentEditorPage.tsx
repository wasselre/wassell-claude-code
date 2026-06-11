import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Braces,
  Check,
  Cloud,
  CloudOff,
  FileDown,
  FolderInput,
  History,
  Link2,
  ListTree,
  Loader2,
  Maximize2,
  MessageSquareText,
  Minimize2,
  PanelTopClose,
  PanelTopOpen,
  Settings2,
  Share2,
  Sparkles,
  Users,
} from 'lucide-react';
import type { Editor, JSONContent } from '@tiptap/react';
import { useAppStore } from '@/stores/appStore';
import type { DocApprovalStatus, FileRow, WasselDocumentRow } from '@/types';
import {
  loadDocument,
  renameDocument,
  saveDocument,
  saveDocumentSettings,
  setApprovalStatus,
} from '@/lib/documents/client';
import { maybeAutoSnapshot, snapshotVersion, type DocVersionFull } from '@/lib/documents/versions';
import {
  bootstrapCollabDoc,
  caretColorFor,
  encodeYDocState,
  type CollabPeer,
  type CollabSession,
} from '@/lib/documents/collab';
import VersionHistoryModal from './components/VersionHistoryModal';
import ApprovalStatusPill from './components/ApprovalStatusPill';
import {
  DEFAULT_PAGE_SETTINGS,
  normalizePageSettings,
  pageCanvasStyle,
  type PageSettings,
} from '@/lib/documents/pageSettings';
import PageSettingsModal from './components/PageSettingsModal';
import ShareLinkModal from '@/pages/Files/components/ShareLinkModal';
import PermissionsPanel from '@/pages/Files/components/PermissionsPanel';
import MoveToFolderModal from '@/pages/Files/components/MoveToFolderModal';
import LinkedRecordsModal from './components/LinkedRecordsModal';
import CrmVariablesPopover from './components/CrmVariablesPopover';
import DocAssistModal from './components/DocAssistModal';
import DocumentOutline from './components/DocumentOutline';
import ExportModal from './components/ExportModal';
import { listLinksForFile, type DocumentLink } from '@/lib/documents/links';
import { resolveDocVariables } from '@/lib/documents/variables';
import { buildAssistContext } from '@/lib/documents/assist';
import {
  addComment,
  deleteComment,
  listCommentThreads,
  replyToComment,
  setThreadResolved,
  type CommentThread,
  type DocComment,
} from '@/lib/documents/comments';
import { collectCommentAnchors, refreshCommentHighlights } from './components/CommentMarkExtension';
import CommentsPanel, { type PendingAnchor } from './components/CommentsPanel';
import DocumentEditor, { type DocumentEditorHandle } from './components/DocumentEditor';
import DocumentToolbar from './components/DocumentToolbar';
import './documents.css';

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 1500;

/**
 * Full-page Wassel document editor. URL: /files/doc/:fileId.
 *
 * Loads the file row + body once, lets the user edit, autosaves on a debounced
 * change handler, and exposes a manual Save button as a fallback. The
 * back button returns to the document's parent folder so the user lands
 * where they came from.
 */
export default function DocumentEditorPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const [file, setFile] = useState<FileRow | null>(null);
  const [doc, setDoc] = useState<WasselDocumentRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [titleDraft, setTitleDraft] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Only meaningful while fullscreen — hides the doc header for a pure
   *  page-only view. Reset whenever we leave fullscreen. */
  const [headerHidden, setHeaderHidden] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [permsOpen, setPermsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const [pageSettings, setPageSettings] = useState<PageSettings>(DEFAULT_PAGE_SETTINGS);
  /** Outline panel visibility — persisted so the preference sticks. Only
   *  rendered on lg+ screens (the canvas margin hosts it). */
  const [outlineOpen, setOutlineOpen] = useState<boolean>(
    () => localStorage.getItem('wassell_doc_outline_open') !== '0',
  );
  const toggleOutline = () => {
    setOutlineOpen((v) => {
      localStorage.setItem('wassell_doc_outline_open', v ? '0' : '1');
      return !v;
    });
  };
  /** AI assist — selection snapshot captured the moment the modal opens, so
   *  Replace targets the exact original range even after the editor blurs. */
  const [assist, setAssist] = useState<{ from: number; to: number; text: string } | null>(null);
  /** Comments — the PAGE owns thread state so highlights + the header badge
   *  work even while the panel is closed. anchorPositions maps thread id →
   *  first mark position (sorting + orphan detection). */
  const [commentsOpen, setCommentsOpen] = useState<boolean>(
    () => localStorage.getItem('wassell_doc_comments_open') === '1',
  );
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [anchorPositions, setAnchorPositions] = useState<Map<string, number>>(new Map());
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingComment, setPendingComment] = useState<PendingAnchor | null>(null);
  /** Version history + approval workflow. approvalRef mirrors the state so
   *  doSave's auto-demote check doesn't have to re-create the save closure
   *  on every status change. */
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [approvalStatus, setApprovalStatusState] = useState<DocApprovalStatus>('draft');
  const [approvalBusy, setApprovalBusy] = useState(false);
  const approvalRef = useRef<DocApprovalStatus>('draft');
  approvalRef.current = approvalStatus;
  /** Suggestions (tracked changes) mode — per-session, off by default. */
  const [suggesting, setSuggesting] = useState(false);
  /** Real-time collaboration. The editor mounts only after the bootstrap
   *  resolves (shared Y.Doc hydrated, Realtime channel joined) — or with a
   *  null session as the plain single-user fallback. */
  const [collabSession, setCollabSession] = useState<CollabSession | null>(null);
  const [collabReady, setCollabReady] = useState(false);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const collabRef = useRef<CollabSession | null>(null);
  /** Caller's effective role (owner grant / direct grant / folder cascade).
   *  Shared editors get the full editing surface — that's what makes
   *  co-editing real. Viewers stay read-only. */
  const [myRole, setMyRole] = useState<'viewer' | 'editor' | 'owner'>('viewer');
  const users = useAppStore((s) => s.users);
  /** Record relationships — drive CRM variable resolution. Refreshed after
   *  the Linked-records modal closes (links may have changed). */
  const [docLinks, setDocLinks] = useState<DocumentLink[]>([]);
  const models = useAppStore((s) => s.models);
  const recordsMap = useAppStore((s) => s.records);

  const editorRef = useRef<DocumentEditorHandle>(null);
  const saveTimerRef = useRef<number | null>(null);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const fileImageInputRef = useRef<HTMLInputElement>(null);
  /** Latest persisted wassel_documents.version — stamped onto snapshots. */
  const docVersionRef = useRef(1);

  // Effective-role-aware (was uploader-only): folder-cascade and direct
  // grants give shared editors the real editing surface — co-editing needs
  // that. RLS remains the authoritative server-side gate.
  const canEdit = !!file && !!currentUserId && myRole !== 'viewer';
  const isOwner = myRole === 'owner';

  // Load the document's record links (CRM variable sources) once the file is
  // known, and re-load after the Linked-records modal closes.
  const refreshLinks = useCallback(() => {
    if (!fileId) return;
    listLinksForFile(fileId)
      .then(setDocLinks)
      .catch(() => {
        /* surfaced by the links client */
      });
  }, [fileId]);
  useEffect(() => {
    refreshLinks();
  }, [refreshLinks]);

  /** slug → resolved value + grouped list for the insert popover. Recomputes
   *  when links or the underlying records change (store subscription). */
  const resolvedVars = useMemo(
    () => resolveDocVariables(docLinks, models, recordsMap, isAr),
    [docLinks, models, recordsMap, isAr],
  );

  // ─── Comments ───────────────────────────────────────────────────────────

  const refreshThreads = useCallback(() => {
    if (!fileId) return;
    listCommentThreads(fileId)
      .then(setThreads)
      .catch(() => {
        /* surfaced by the comments client */
      });
  }, [fileId]);
  useEffect(() => {
    refreshThreads();
  }, [refreshThreads]);

  const recomputeAnchors = useCallback(() => {
    const ed = editorRef.current?.editor;
    if (ed) setAnchorPositions(collectCommentAnchors(ed));
  }, []);
  // First map once the editor mounts (anchors live in the loaded content).
  useEffect(() => {
    if (editor) recomputeAnchors();
  }, [editor, recomputeAnchors]);

  // Paint highlights for unresolved threads; strongest tint for the active
  // one. Resolved threads keep their mark in the content (Reopen restores
  // the highlight) but get no decoration.
  useEffect(() => {
    if (!editor) return;
    const openIds = new Set(threads.filter((th) => !th.root.resolved).map((th) => th.root.id));
    refreshCommentHighlights(editor, openIds, activeCommentId);
  }, [editor, threads, activeCommentId]);

  const openThreadCount = useMemo(() => threads.filter((th) => !th.root.resolved).length, [threads]);

  const toggleComments = useCallback(() => {
    setCommentsOpen((v) => {
      localStorage.setItem('wassell_doc_comments_open', v ? '0' : '1');
      if (v) setActiveCommentId(null);
      return !v;
    });
  }, []);

  /** Toolbar "comment" — snapshot the selection and open the composer. */
  const onAddComment = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    setPendingComment({ from, to, text: editor.state.doc.textBetween(from, to, ' ') });
    setCommentsOpen(true);
    localStorage.setItem('wassell_doc_comments_open', '1');
  }, [editor]);

  const onReplyComment = useCallback(
    async (rootId: string, body: string) => {
      if (!fileId) return;
      await replyToComment(fileId, rootId, body);
      refreshThreads();
    },
    [fileId, refreshThreads],
  );

  const onSetThreadResolved = useCallback(
    async (rootId: string, resolved: boolean) => {
      await setThreadResolved(rootId, resolved);
      refreshThreads();
    },
    [refreshThreads],
  );

  const onDeleteComment = useCallback(
    async (comment: DocComment, isRoot: boolean) => {
      await deleteComment(comment.id);
      if (isRoot && editor) {
        // Drop the anchor mark everywhere; autosave persists the change.
        editor.commands.unsetCommentById(comment.id);
        recomputeAnchors();
      }
      if (activeCommentId === comment.id) setActiveCommentId(null);
      refreshThreads();
    },
    [editor, activeCommentId, recomputeAnchors, refreshThreads],
  );

  /** Thread card clicked — highlight + scroll the document to its anchor. */
  const onActivateThread = useCallback(
    (id: string | null) => {
      setActiveCommentId(id);
      if (!id || !editor) return;
      const el = editor.view.dom.querySelector(`span[data-comment-id="${id}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    [editor],
  );

  // Load document on mount / fileId change.
  useEffect(() => {
    if (!fileId) {
      setLoadError('No document id');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void loadDocument(fileId)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setLoadError(t('doc.editor.not_found'));
          setLoading(false);
          return;
        }
        setFile(res.file);
        setDoc(res.doc);
        setTitleDraft(res.file.original_name);
        setPageSettings(normalizePageSettings(res.doc.settings));
        setApprovalStatusState(res.doc.approval_status ?? 'draft');
        docVersionRef.current = res.doc.version;
        setMyRole(res.myRole);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, t]);

  // Real-time collaboration bootstrap: hydrate (or first-seed) the shared
  // Y.Doc, join the Realtime channel, and surface peer presence. The editor
  // mounts only after this resolves; a null session = plain single-user
  // editor (Supabase absent or bootstrap failure — both stay editable).
  useEffect(() => {
    if (!file || !doc) return;
    let cancelled = false;
    let session: CollabSession | null = null;
    const me = users.find((u) => u.id === currentUserId);
    const myName = me ? (isAr ? me.name_ar : me.name_en) || me.email : '—';
    bootstrapCollabDoc(file.id, doc, { name: myName, color: caretColorFor(currentUserId ?? '') })
      .then((s) => {
        if (cancelled) {
          s?.provider.destroy();
          s?.ydoc.destroy();
          return;
        }
        session = s;
        collabRef.current = s;
        setCollabSession(s);
        setCollabReady(true);
        if (s) {
          s.provider.awareness.on('change', () => {
            setPeers(s ? s.provider.peers() : []);
          });
        }
      })
      .catch((err) => {
        console.error('[collab] bootstrap failed — opening single-user:', err);
        if (!cancelled) {
          collabRef.current = null;
          setCollabSession(null);
          setCollabReady(true);
        }
      });
    return () => {
      cancelled = true;
      session?.provider.destroy();
      session?.ydoc.destroy();
      collabRef.current = null;
      setCollabSession(null);
      setCollabReady(false);
      setPeers([]);
    };
    // Re-bootstrapping on every doc-row update would tear down live sessions;
    // file identity is the real dependency (doc is loaded alongside it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, doc?.file_id]);

  // The bootstrap above can run before the store's users list arrives, which
  // would leave the awareness name as the '—' fallback. Re-stamp the local
  // awareness user whenever identity data lands (peers see names via
  // awareness, so this is what their avatars + caret labels read).
  useEffect(() => {
    const s = collabRef.current;
    if (!s || !currentUserId) return;
    const me = users.find((u) => u.id === currentUserId);
    if (!me) return;
    s.provider.awareness.setLocalStateField('user', {
      name: (isAr ? me.name_ar : me.name_en) || me.email,
      color: caretColorFor(currentUserId),
    });
  }, [users, currentUserId, isAr, collabSession]);

  // Flush any pending autosave on unmount so a quick exit doesn't drop the
  // last 1.5 s of edits.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  // Best-effort flush on page unload too — modern browsers will run sync
  // handlers but not async fetches, so we only have time to enqueue. Good
  // enough as a backstop; autosave's 1.5 s window catches most cases first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStatus === 'dirty' || saveStatus === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveStatus]);

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
    setHeaderHidden(false);
  }, []);

  // While fullscreen, flag the <html> element. The doc overlay sits at z-60
  // (above the z-50 app sidebar so it's truly hidden); `documents.css` keys
  // off `html.doc-fullscreen` to lift the global modal + toast layers ABOVE
  // the overlay so Share/Move dialogs and error toasts still reach the user.
  useEffect(() => {
    if (!isFullscreen) return;
    document.documentElement.classList.add('doc-fullscreen');
    return () => document.documentElement.classList.remove('doc-fullscreen');
  }, [isFullscreen]);

  // Esc exits fullscreen — but only when no modal is open, otherwise the
  // first Esc should close the modal (the modal owns that keystroke). We
  // register on window so it fires regardless of focus inside the editor.
  const anyModalOpen = shareOpen || permsOpen || moveOpen;
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !anyModalOpen) {
        exitFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, anyModalOpen, exitFullscreen]);

  const doSave = useCallback(async () => {
    if (!fileId || !editorRef.current) return;
    if (!canEdit) return;
    const contentJson = editorRef.current.getJSON() as Record<string, unknown>;
    const contentHtml = editorRef.current.getHTML();
    setSaveStatus('saving');
    try {
      const { version } = await saveDocument({
        fileId,
        contentJson,
        contentHtml,
        // Persist the merged CRDT state so late joiners share identities.
        // Remote peers' updates land in OUR ydoc too, so whichever client
        // saves last persists everyone's edits.
        ...(collabRef.current ? { ydocState: encodeYDocState(collabRef.current.ydoc) } : {}),
      });
      docVersionRef.current = version;
      setSaveStatus('saved');
      // Edits may have deleted (or restored via undo) comment anchors —
      // refresh the position map so the panel's orphan badges stay honest.
      recomputeAnchors();
      // Version history: throttled auto snapshot (self-noops within 10 min).
      void maybeAutoSnapshot({ fileId, docVersion: version, contentJson, contentHtml });
      // A content edit on an approved/published doc invalidates its stamp —
      // demote to draft loudly so a stale stamp never covers newer text.
      if (approvalRef.current === 'approved' || approvalRef.current === 'published') {
        try {
          const updated = await setApprovalStatus(fileId, 'draft');
          setApprovalStatusState(updated.approval_status);
          addToast(t('doc.approval.demoted'), 'info');
        } catch {
          // surfaceError already toasted inside the client.
        }
      }
    } catch {
      // surfaceError already toasted.
      setSaveStatus('error');
    }
  }, [fileId, canEdit, recomputeAnchors, addToast, t]);

  /** Debounced autosave — every onChange resets a 1.5 s timer. We serialize
   *  with `inFlightSaveRef` so a fast typist can't queue two overlapping
   *  saves that race; the next save waits for the current one to finish. */
  const scheduleSave = useCallback(() => {
    if (!canEdit) return;
    setSaveStatus('dirty');
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const run = async () => {
        if (inFlightSaveRef.current) {
          // Wait for the previous save to finish before issuing the next one.
          await inFlightSaveRef.current.catch(() => undefined);
        }
        const p = doSave();
        inFlightSaveRef.current = p as unknown as Promise<void>;
        await p;
        inFlightSaveRef.current = null;
      };
      void run();
    }, AUTOSAVE_DELAY_MS);
  }, [canEdit, doSave]);

  // Manual save button — flush any pending timer and save immediately.
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (inFlightSaveRef.current) {
      await inFlightSaveRef.current.catch(() => undefined);
    }
    await doSave();
  }, [doSave]);

  /** Comment composer submit: insert the row, anchor it with the mark on the
   *  snapshotted selection, persist immediately (a comment whose mark never
   *  saves would reload as orphaned). Lives below flushSave on purpose. */
  const submitPendingComment = useCallback(
    async (body: string) => {
      if (!fileId || !editor || !pendingComment) return;
      const row = await addComment(fileId, body, pendingComment.text);
      editor
        .chain()
        .setTextSelection({ from: pendingComment.from, to: pendingComment.to })
        .setComment(row.id)
        .run();
      setPendingComment(null);
      setActiveCommentId(row.id);
      await flushSave();
      recomputeAnchors();
      refreshThreads();
    },
    [fileId, editor, pendingComment, flushSave, recomputeAnchors, refreshThreads],
  );

  /** Approval transition. Moving INTO approved/published stamps an
   *  'approval' version snapshot — the audit trail of what was approved. */
  const onChangeApproval = useCallback(
    async (next: DocApprovalStatus) => {
      if (!fileId || approvalBusy) return;
      setApprovalBusy(true);
      try {
        const updated = await setApprovalStatus(fileId, next);
        setApprovalStatusState(updated.approval_status);
        if (next === 'approved' || next === 'published') {
          await snapshotVersion({
            fileId,
            docVersion: docVersionRef.current,
            kind: 'approval',
            label: t(`doc.approval.${next}`),
            contentJson: editorRef.current?.getJSON() as Record<string, unknown>,
            contentHtml: editorRef.current?.getHTML() ?? '',
          });
        }
        addToast(t('doc.approval.changed', { status: t(`doc.approval.${next}`) }), 'success');
      } catch {
        // surfaced by the client libs
      } finally {
        setApprovalBusy(false);
      }
    },
    [fileId, approvalBusy, addToast, t],
  );

  /** Restore a version: safety-snapshot the CURRENT content first, then
   *  swap the editor content and persist. */
  const onRestoreVersion = useCallback(
    async (v: DocVersionFull) => {
      const ed = editorRef.current?.editor;
      if (!fileId || !ed) return;
      await snapshotVersion({
        fileId,
        docVersion: docVersionRef.current,
        kind: 'restore',
        label: t('doc.versions.before_restore'),
        contentJson: editorRef.current?.getJSON() as Record<string, unknown>,
        contentHtml: editorRef.current?.getHTML() ?? '',
      });
      ed.commands.setContent(v.content_json as Parameters<typeof ed.commands.setContent>[0]);
      await flushSave();
      recomputeAnchors();
      addToast(t('doc.versions.restored'), 'success');
    },
    [fileId, flushSave, recomputeAnchors, addToast, t],
  );

  const onTitleBlur = useCallback(async () => {
    if (!file || !canEdit) return;
    const next = titleDraft.trim();
    if (!next || next === file.original_name) {
      setTitleDraft(file.original_name);
      return;
    }
    try {
      const updated = await renameDocument(file.id, next);
      setFile(updated);
      setTitleDraft(updated.original_name);
    } catch {
      // surfaceError already toasted; revert UI.
      setTitleDraft(file.original_name);
    }
  }, [file, titleDraft, canEdit]);

  /** Insert an image. v1 stores images as base64 data URIs inline in the
   *  document JSON — simple, works forever, no signed-URL expiry to manage.
   *  Tradeoff: large images bloat the saved JSON, so we cap at 2 MB and
   *  show a toast asking the user to upload to Files + link to it instead
   *  for anything bigger.
   *
   *  v2 idea: store a `{ src: 'wassel-file:<id>' }` placeholder and resolve
   *  via signViewUrl at render time. Would let docs reference image files
   *  in the user's library without duplication. */
  const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
  const onInsertImage = useCallback(() => {
    if (!canEdit) return;
    fileImageInputRef.current?.click();
  }, [canEdit]);

  const onImageFilePicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > IMAGE_MAX_BYTES) {
        addToast(t('doc.editor.image_too_large'), 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : null;
        if (!dataUrl) return;
        editorRef.current?.insertImage(dataUrl, f.name);
      };
      reader.onerror = () => addToast(t('doc.editor.image_read_failed'), 'error');
      reader.readAsDataURL(f);
    },
    [addToast, t, IMAGE_MAX_BYTES],
  );

  // ─── Render ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 size={28} className="animate-spin text-copper" />
      </div>
    );
  }

  if (loadError || !file || !doc) {
    return (
      <div className="p-12 max-w-md mx-auto text-center">
        <div className="font-bold text-charcoal mb-2">{t('doc.editor.load_failed')}</div>
        <div className="text-charcoal/60 text-sm mb-6">{loadError ?? t('doc.editor.not_found')}</div>
        <button
          onClick={() => navigate('/files')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-copper text-white hover:bg-terracotta font-bold text-sm"
        >
          <ArrowLeft size={16} />
          {t('doc.editor.back_to_files')}
        </button>
      </div>
    );
  }

  return (
    <div
      className={
        // Fullscreen: a `fixed inset-0` overlay at z-60 paints over the app
        // sidebar AND header (both fixed at z-50/z-30). The doc's own modals +
        // toasts are lifted above z-60 via the `html.doc-fullscreen` rules in
        // documents.css so they still appear on top. Esc exits. The canvas
        // class is the gray area AROUND the page.
        isFullscreen
          ? 'fixed inset-0 z-[60] overflow-y-auto wassel-doc-canvas wassel-doc-surface'
          : 'min-h-screen wassel-doc-canvas wassel-doc-surface'
      }
      dir={isAr ? 'rtl' : 'ltr'}
    >
      {/* Header — full-width top bar (Google-Docs style). Hidden entirely when
          the user chooses the header-less focus view (fullscreen only). */}
      {!headerHidden && (
        <div className="bg-white border-b border-sand/30 sticky top-0 z-10">
          <div className="px-4 sm:px-6 py-3 flex items-center gap-2">
            {/* Back is hidden in fullscreen — Exit fullscreen is the way out. */}
            {!isFullscreen && (
              <button
                onClick={() => navigate(file.folder_id ? `/files/${file.folder_id}` : '/files')}
                className="p-2 rounded-lg text-charcoal/60 hover:text-charcoal hover:bg-cream shrink-0"
                title={t('doc.editor.back_to_files')}
                aria-label={t('doc.editor.back_to_files')}
              >
                <ArrowLeft size={18} className={isAr ? 'rotate-180' : ''} />
              </button>
            )}
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={onTitleBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              disabled={!canEdit}
              dir="auto"
              placeholder={t('doc.editor.untitled')}
              className="flex-1 min-w-0 px-2 py-1.5 rounded-md text-lg font-bold text-charcoal bg-transparent border border-transparent hover:border-sand/40 focus:border-copper focus:outline-none disabled:hover:border-transparent"
            />
            <SaveStatusBadge status={canEdit ? saveStatus : 'idle'} canEdit={canEdit} />

            {/* Live peers editing/viewing this doc right now (awareness). */}
            {peers.length > 0 && (
              <div className="hidden sm:flex items-center -space-x-1.5 shrink-0" dir="ltr">
                {peers.slice(0, 5).map((p) => (
                  <span
                    key={p.clientId}
                    title={p.name}
                    style={{ backgroundColor: p.color }}
                    className="w-6 h-6 rounded-full text-white text-[0.625rem] font-bold flex items-center justify-center ring-2 ring-white"
                  >
                    {p.name.trim().charAt(0) || '?'}
                  </span>
                ))}
                {peers.length > 5 && (
                  <span className="w-6 h-6 rounded-full bg-charcoal/30 text-white text-[0.625rem] font-bold flex items-center justify-center ring-2 ring-white">
                    +{peers.length - 5}
                  </span>
                )}
              </div>
            )}

            {/* Approval workflow pill (draft/review/approved/published). */}
            <ApprovalStatusPill
              status={approvalStatus}
              canEdit={canEdit}
              isOwner={isOwner}
              busy={approvalBusy}
              onChange={(next) => void onChangeApproval(next)}
            />

            {/* Share / Permissions / Move — only for users who can edit the doc.
                These reuse the exact Files-section modals so behavior is
                identical to managing the file from the Files grid. */}
            {canEdit && (
              <div className="flex items-center gap-0.5 shrink-0">
                <HeaderIconBtn icon={Share2} label={t('files.actions.share')} onClick={() => setShareOpen(true)} />
                <HeaderIconBtn icon={Users} label={t('files.actions.permissions')} onClick={() => setPermsOpen(true)} />
                <HeaderIconBtn icon={FolderInput} label={t('files.actions.move')} onClick={() => setMoveOpen(true)} />
                <HeaderIconBtn icon={Link2} label={t('doc.links.title')} onClick={() => setLinksOpen(true)} />
                <HeaderIconBtn icon={Braces} label={t('doc.vars.title')} onClick={() => setVarsOpen(true)} />
                <HeaderIconBtn icon={Settings2} label={t('doc.page.title')} onClick={() => setPageSetupOpen(true)} />
                <HeaderIconBtn
                  icon={Sparkles}
                  label={t('doc.assist.title')}
                  onClick={() => {
                    if (!editor) return;
                    const { from, to, empty } = editor.state.selection;
                    setAssist({
                      from,
                      to,
                      text: empty ? '' : editor.state.doc.textBetween(from, to, '\n'),
                    });
                  }}
                />
              </div>
            )}

            {/* Hide-header — only relevant in fullscreen (in normal mode the
                app chrome is the way out). Collapses to the headerless view. */}
            {isFullscreen && (
              <HeaderIconBtn
                icon={PanelTopClose}
                label={t('doc.editor.hide_header')}
                onClick={() => setHeaderHidden(true)}
              />
            )}

            {/* Comments toggle — available to everyone (viewers can read and
                reply; only editors can create anchors). Badge = open threads. */}
            <div className="relative shrink-0">
              <HeaderIconBtn
                icon={MessageSquareText}
                label={t('doc.comments.title')}
                onClick={toggleComments}
              />
              {openThreadCount > 0 && (
                <span className="absolute -top-0.5 -end-0.5 min-w-[1rem] h-4 px-1 rounded-full bg-copper text-white text-[0.625rem] font-bold flex items-center justify-center pointer-events-none">
                  {openThreadCount}
                </span>
              )}
            </div>

            {/* Outline toggle — available to everyone (readers navigate too). */}
            <HeaderIconBtn
              icon={ListTree}
              label={t('doc.outline.title')}
              onClick={toggleOutline}
            />

            {/* Version history — list/preview for anyone with view access;
                restore + manual snapshots are edit-gated inside the modal. */}
            <HeaderIconBtn icon={History} label={t('doc.versions.title')} onClick={() => setVersionsOpen(true)} />

            {/* Export — also for read-only viewers. */}
            <HeaderIconBtn icon={FileDown} label={t('doc.export.title')} onClick={() => setExportOpen(true)} />

            {/* Fullscreen enter / exit — available to everyone (viewers can
                focus-read too). Exit lives HERE in the header, not floating. */}
            <HeaderIconBtn
              icon={isFullscreen ? Minimize2 : Maximize2}
              label={isFullscreen ? t('doc.editor.exit_fullscreen') : t('doc.editor.fullscreen')}
              onClick={() => (isFullscreen ? exitFullscreen() : setIsFullscreen(true))}
            />

            {canEdit && (
              <button
                onClick={() => void flushSave()}
                disabled={saveStatus === 'saving'}
                className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-copper text-white hover:bg-terracotta font-bold text-sm disabled:opacity-50 shrink-0"
              >
                {t('common.save')}
              </button>
            )}
          </div>

          {canEdit && (
            <DocumentToolbar
              editor={editor}
              onInsertImage={onInsertImage}
              onAddComment={onAddComment}
              suggesting={suggesting}
              onToggleSuggesting={() => setSuggesting((v) => !v)}
            />
          )}
        </div>
      )}

      {/* Canvas padding around the page. The page itself is the white A4-style
          rectangle; the editor fills it (margins come from the page padding).
          On lg+ the outline panel docks at the inline-start of the canvas. */}
      <div className="px-3 sm:px-6 py-6 sm:py-10 lg:flex lg:items-start lg:gap-3">
        {outlineOpen && (
          <div className="hidden lg:block w-56 shrink-0 sticky top-36 max-h-[70vh] overflow-y-auto">
            <DocumentOutline editor={editor} />
          </div>
        )}
        <div className="flex-1 min-w-0">
        <div className="wassel-doc-page" style={{ ...pageCanvasStyle(pageSettings), maxWidth: '100%' }}>
          {!collabReady ? (
            <div className="min-h-[40vh] flex items-center justify-center">
              <Loader2 size={22} className="animate-spin text-copper/60" />
            </div>
          ) : (
          <DocumentEditor
            key={`${file.id}:${collabSession ? 'collab' : 'solo'}`}
            ref={editorRef}
            initialContent={(doc.content_json as JSONContent) ?? { type: 'doc', content: [{ type: 'paragraph' }] }}
            editable={canEdit}
            onChange={scheduleSave}
            placeholder={t('doc.editor.placeholder')}
            baseDir={isAr ? 'rtl' : 'ltr'}
            onReady={(ed) => setEditor(ed)}
            ydoc={collabSession?.ydoc ?? null}
            collabProvider={collabSession?.provider ?? null}
            collabUser={
              collabSession
                ? {
                    name:
                      (() => {
                        const me = users.find((u) => u.id === currentUserId);
                        return me ? (isAr ? me.name_ar : me.name_en) || me.email : '—';
                      })(),
                    color: caretColorFor(currentUserId ?? ''),
                  }
                : null
            }
            crmVars={resolvedVars.values}
            onMentionClick={(attrs) => {
              const m = models.find((x) => x.id === attrs.modelId);
              if (!m) {
                addToast(t('doc.mentions.record_gone'), 'error');
                return;
              }
              navigate(`/model/${m.name}/${attrs.id}`);
            }}
            onCommentClick={(id) => {
              setActiveCommentId(id);
              setCommentsOpen(true);
              localStorage.setItem('wassell_doc_comments_open', '1');
            }}
            suggesting={suggesting}
            suggestAuthor={currentUserId}
          />
          )}
        </div>
        </div>
        {commentsOpen && (
          <div className="hidden lg:block w-80 shrink-0 sticky top-36">
            <CommentsPanel
              threads={threads}
              anchorPositions={anchorPositions}
              activeId={activeCommentId}
              onActivate={onActivateThread}
              pending={pendingComment}
              onSubmitPending={submitPendingComment}
              onCancelPending={() => setPendingComment(null)}
              onReply={onReplyComment}
              onSetResolved={onSetThreadResolved}
              onDelete={onDeleteComment}
              onClose={toggleComments}
              canComment={canEdit}
            />
          </div>
        )}
      </div>

      {/* Header-less focus view (fullscreen + headerHidden): a tiny floating
          control so the user can bring the header back or exit. Stays subtle
          until hovered so it doesn't intrude on the page. */}
      {isFullscreen && headerHidden && (
        <div className="fixed top-3 end-3 z-[61] flex items-center gap-1 bg-white/80 hover:bg-white backdrop-blur-sm border border-sand/40 rounded-full shadow-md px-1 py-1 transition-colors">
          <HeaderIconBtn
            icon={PanelTopOpen}
            label={t('doc.editor.show_header')}
            onClick={() => setHeaderHidden(false)}
          />
          <HeaderIconBtn
            icon={Minimize2}
            label={t('doc.editor.exit_fullscreen')}
            onClick={exitFullscreen}
          />
        </div>
      )}

      {/* Hidden file input for image inserts. */}
      <input
        ref={fileImageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={onImageFilePicked}
      />

      {/* Reused Files-section modals — share link, user permissions, folder
          location. They render via portal at z-50, above the fullscreen
          overlay. onMoved updates the local file so the back-button + future
          saves target the new folder. */}
      <ShareLinkModal file={shareOpen ? file : null} open={shareOpen} onClose={() => setShareOpen(false)} />
      <PermissionsPanel
        target={permsOpen ? { kind: 'file', row: file } : null}
        open={permsOpen}
        onClose={() => setPermsOpen(false)}
      />
      <MoveToFolderModal
        file={moveOpen ? file : null}
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        onMoved={() => {
          // Reflect the new location locally so Back returns to the right
          // folder without a reload.
          void loadDocument(file.id).then((res) => {
            if (res) setFile(res.file);
          });
        }}
      />
      <LinkedRecordsModal
        fileId={file.id}
        open={linksOpen}
        onClose={() => {
          setLinksOpen(false);
          refreshLinks();
        }}
      />
      <DocAssistModal
        open={!!assist}
        selectionText={assist?.text ?? ''}
        docTitle={file.original_name}
        context={buildAssistContext(resolvedVars.groups)}
        onClose={() => setAssist(null)}
        onReplace={(result) => {
          if (!editor || !assist) return;
          editor
            .chain()
            .focus()
            .insertContentAt({ from: assist.from, to: assist.to }, assistResultContent(result))
            .run();
        }}
        onInsertBelow={(result) => {
          if (!editor || !assist) return;
          editor.chain().focus().insertContentAt(assist.to, assistResultContent(result, true)).run();
        }}
      />
      <ExportModal
        open={exportOpen}
        title={file.original_name}
        settings={pageSettings}
        getJson={() => editorRef.current?.getJSON() ?? { type: 'doc', content: [] }}
        getHtml={() => editorRef.current?.getHTML() ?? ''}
        onClose={() => setExportOpen(false)}
      />
      <VersionHistoryModal
        open={versionsOpen}
        fileId={file.id}
        docVersion={docVersionRef.current}
        getJson={() => (editorRef.current?.getJSON() ?? { type: 'doc' }) as Record<string, unknown>}
        getHtml={() => editorRef.current?.getHTML() ?? ''}
        canEdit={canEdit}
        onClose={() => setVersionsOpen(false)}
        onRestore={onRestoreVersion}
      />
      <PageSettingsModal
        open={pageSetupOpen}
        value={pageSettings}
        onClose={() => setPageSetupOpen(false)}
        onSave={async (next) => {
          await saveDocumentSettings(file.id, next as unknown as Record<string, unknown>);
          setPageSettings(next);
        }}
      />
      <CrmVariablesPopover
        open={varsOpen}
        groups={resolvedVars.groups}
        onClose={() => setVarsOpen(false)}
        onManageLinks={() => setLinksOpen(true)}
        onInsert={(slug) => {
          editor?.chain().focus().insertContent(`{{${slug}}}`).run();
          setVarsOpen(false);
        }}
      />
    </div>
  );
}

interface HeaderIconBtnProps {
  icon: typeof Share2;
  label: string;
  onClick: () => void;
}

/** Build TipTap content from an assist result: inline text for a single-line
 *  result (keeps the surrounding paragraph intact), paragraph nodes for
 *  multi-line. forceBlocks makes insert-below always land as paragraphs. */
function assistResultContent(result: string, forceBlocks = false): JSONContent | JSONContent[] {
  const lines = result
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!forceBlocks && lines.length <= 1) {
    return { type: 'text', text: lines[0] ?? result };
  }
  return lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
}

function HeaderIconBtn({ icon: Icon, label, onClick }: HeaderIconBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="p-2 rounded-lg text-charcoal/60 hover:text-charcoal hover:bg-cream transition-colors shrink-0"
    >
      <Icon size={18} />
    </button>
  );
}

function SaveStatusBadge({ status, canEdit }: { status: SaveStatus; canEdit: boolean }) {
  const { t } = useTranslation();
  const map = useMemo(
    () => ({
      idle: { icon: Cloud, label: t('doc.editor.status_idle'), cls: 'text-charcoal/40' },
      dirty: { icon: Cloud, label: t('doc.editor.status_dirty'), cls: 'text-amber-600' },
      saving: { icon: Loader2, label: t('doc.editor.status_saving'), cls: 'text-charcoal/60 animate-spin' },
      saved: { icon: Check, label: t('doc.editor.status_saved'), cls: 'text-emerald-600' },
      error: { icon: CloudOff, label: t('doc.editor.status_error'), cls: 'text-red-600' },
    }),
    [t],
  );
  if (!canEdit) {
    return (
      <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-charcoal/50">
        {t('doc.editor.view_only')}
      </span>
    );
  }
  const item = map[status];
  const Icon = item.icon;
  return (
    <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-charcoal/60">
      <Icon size={14} className={item.cls} />
      <span>{item.label}</span>
    </span>
  );
}
