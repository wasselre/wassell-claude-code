/**
 * Mint a tracked link for a message a rep is about to send
 * (POST /api/tracked-links/create). See api/tracked-links/create.ts.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

export type LinkSection = 'photos' | 'videos' | 'brochure' | 'units' | 'location';

export interface MintedLink {
  token: string;
  sections: LinkSection[];
  urls: Partial<Record<LinkSection, string>>;
  unitUrl: string | null;
  /** Ready-to-paste links text for a project message (null for a unit link). */
  block: string | null;
  /** The cover photo to attach instead of the gallery. */
  coverFileId: string | null;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function mintTrackedLink(input: {
  projectId: string;
  chatWid: string;
  unitId?: string | null;
  lang: 'ar' | 'en';
  sentVia?: 'rep' | 'bulk';
  /** 'units' when the message is the project's units list (not the whole project). */
  focus?: 'project' | 'units';
  /** Limit a units-list link to these units (the rep's filtered selection). */
  unitIds?: string[];
}): Promise<MintedLink> {
  const res = await fetch('/api/tracked-links/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  const json = (await res.json().catch(() => null)) as (MintedLink & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error || `tracked link failed (${res.status})`);
  return json;
}

/**
 * Send a units list (`unitId` absent) or one unit (`unitId` set) to a
 * conversation as a TRACKED LINK instead of a PDF: mint the link for this chat,
 * then send `caption` + the link as one text message through the store (which
 * owns the optimistic bubble, the send lane and the failure toast).
 * Throws when the link can't be minted — the caller surfaces it.
 */
export async function sendTrackedUnitsLink(input: {
  chatWid: string;
  projectId: string;
  unitId?: string | null;
  lang: 'ar' | 'en';
  caption: string;
  deliverAt?: string;
  /** Units list only: send just these units instead of every available one. */
  unitIds?: string[];
}): Promise<void> {
  const link = await mintTrackedLink({
    projectId: input.projectId,
    chatWid: input.chatWid,
    unitId: input.unitId ?? null,
    lang: input.lang,
    focus: input.unitId ? undefined : 'units',
    unitIds: !input.unitId && input.unitIds?.length ? input.unitIds : undefined,
  });
  const url = input.unitId ? link.unitUrl : link.urls.units;
  if (!url) {
    throw new Error(input.lang === 'ar'
      ? 'لا توجد وحدات متاحة في هذا المشروع لإرسال رابطها'
      : 'This project has no available units to link to');
  }
  const caption = input.caption.trim();
  const body = caption ? `${caption}\n${url}` : url;
  await useAppStore.getState().sendChatMessage(input.chatWid, { body, deliverAt: input.deliverAt });
}

/**
 * Several units (possibly from different projects) in ONE message: one tracked
 * link per unit (a token belongs to one project/unit), one line each.
 */
export async function sendTrackedUnitLinks(input: {
  chatWid: string;
  units: Array<{ projectId: string; unitId: string; label: string }>;
  lang: 'ar' | 'en';
  caption: string;
  deliverAt?: string;
}): Promise<void> {
  const lines: string[] = [];
  for (const u of input.units) {
    const link = await mintTrackedLink({ projectId: u.projectId, chatWid: input.chatWid, unitId: u.unitId, lang: input.lang });
    if (!link.unitUrl) throw new Error(`no unit link for ${u.label}`);
    lines.push(`🏠 ${u.label}\n${link.unitUrl}`);
  }
  const caption = input.caption.trim();
  const body = [caption, ...lines].filter(Boolean).join('\n\n');
  await useAppStore.getState().sendChatMessage(input.chatWid, { body, deliverAt: input.deliverAt });
}
