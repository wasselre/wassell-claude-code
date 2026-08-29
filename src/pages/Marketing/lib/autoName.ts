/**
 * autoName — automatic, informative, lineage-bearing names for the campaign
 * tree (parent campaign → execution → ad set → ad).
 *
 * Every level's name embeds a short summary of its own settings AND its
 * parent's name, so a record's ancestry reads straight off its title:
 *
 *   Parent    «Paid Campaign - Leads - Mina 52 - 2026-08-28»
 *   Execution «Paid ad campaign Meta - {parent}»
 *   Ad set    «Ad set - WhatsApp - {saved audience} - {execution}»
 *   Ad        «Ad, Reel - {ad set}»
 *
 * Names are GENERATED FROM LIVE VALUES at creation and stay fully editable —
 * these builders only ever SEED a blank field or answer a «regenerate» click;
 * they never overwrite what a human typed (that guard lives at the call site).
 * Every segment is optional: an empty goal / project / audience / creative
 * type is simply dropped, never rendered as a blank « -  - ».
 *
 * Bilingual by design — the name follows the creator's UI language at creation
 * time (a snapshot; it does not re-translate later), same as any other value
 * the operator types. Kept in one file so the four levels never drift apart.
 */

/** The lineage separator. Reads cleanly LTR and RTL; matches the brief. */
const SEP = ' - ';

/** Drop empty/whitespace segments, then join with the lineage separator. */
function joinParts(parts: Array<string | null | undefined>): string {
  return parts.map((p) => (p ?? '').trim()).filter(Boolean).join(SEP);
}

/** Join a list of labels (goals, projects) inside one segment. */
function joinList(items: Array<string | null | undefined>, isAr: boolean): string {
  return items.map((s) => (s ?? '').trim()).filter(Boolean).join(isAr ? '، ' : ', ');
}

/** YYYY-MM-DD — locale-neutral and sortable, in both languages. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** «Paid Campaign - Leads - Mina 52 - 2026-08-28» / «حملة مدفوعة - عملاء محتملون - مينا ٥٢ - ٢٠٢٦-٠٨-٢٨». */
export function campaignAutoName(o: {
  kind: 'paid' | 'organic';
  goalLabels: string[];
  projectLabels: string[];
  date: Date;
  isAr: boolean;
}): string {
  const typeWord = o.kind === 'organic'
    ? (o.isAr ? 'عضوية' : 'Organic')
    : (o.isAr ? 'مدفوعة' : 'Paid');
  const head = o.isAr ? `حملة ${typeWord}` : `${typeWord} Campaign`;
  return joinParts([
    head,
    joinList(o.goalLabels, o.isAr),
    joinList(o.projectLabels, o.isAr),
    isoDate(o.date),
  ]);
}

/** «Paid ad campaign Meta - {parent}» / «حملة إعلانية ميتا - {parent}». */
export function executionAutoName(o: {
  platformLabel: string;
  parentName: string;
  isAr: boolean;
}): string {
  const head = o.isAr
    ? `حملة إعلانية ${o.platformLabel}`.trim()
    : `Paid ad campaign ${o.platformLabel}`.trim();
  return joinParts([head, o.parentName]);
}

/** «Ad set - WhatsApp - {audience} - {execution}» / «مجموعة إعلانية - واتساب - {audience} - {execution}». */
export function adSetAutoName(o: {
  conversionLabel?: string | null;
  audienceLabel?: string | null;
  executionName: string;
  isAr: boolean;
}): string {
  const head = o.isAr ? 'مجموعة إعلانية' : 'Ad set';
  return joinParts([head, o.conversionLabel, o.audienceLabel, o.executionName]);
}

/** «Ad, Reel - {ad set}» / «إعلان، ريلز - {ad set}». */
export function adAutoName(o: {
  creativeLabel?: string | null;
  adSetName: string;
  isAr: boolean;
}): string {
  const base = o.isAr ? 'إعلان' : 'Ad';
  const creative = (o.creativeLabel ?? '').trim();
  // The creative type rides on the head segment with its own «, » — «Ad, Reel».
  const head = creative
    ? (o.isAr ? `${base}، ${creative}` : `${base}, ${creative}`)
    : base;
  return joinParts([head, o.adSetName]);
}
