/**
 * What the WhatsApp sales agent says. Written to the reps' measured voice
 * (.claude/skills/wassel-whatsapp-voice): one short Najdi sentence, ONE question,
 * options spoken in one sentence (never bullets), a softener, no fusha, no
 * adjectives, masculine by default and feminine when the customer is.
 *
 * Deterministic on purpose: the LLM never writes free text to a customer — it
 * only understands the customer. Every line here was chosen, not generated.
 */

export type Zone = 'north' | 'south' | 'east' | 'west' | 'center';
export type Lang = 'ar' | 'en';
export type Gender = 'm' | 'f';

const ZONE_AR: Record<Zone, string> = {
  north: 'بالشمال', south: 'بالجنوب', east: 'بالشرق', west: 'بالغرب', center: 'بالوسط',
};
const ZONE_EN: Record<Zone, string> = {
  north: 'in the north', south: 'in the south', east: 'in the east', west: 'in the west', center: 'in central Riyadh',
};

/** «تبي» / «تبين» — the one verb whose gender every question carries. */
const want = (g: Gender) => (g === 'f' ? 'تبين' : 'تبي');

export const agentText = {
  askZone(lang: Lang, g: Gender): string {
    return lang === 'en'
      ? 'Sure. Which part of Riyadh do you prefer? North, east, west or south?'
      : `أبشر، أي جهة بالرياض ${want(g)}؟ الشمال ولا الشرق ولا الغرب ولا الجنوب؟`;
  },

  /** First question of a region lead: acknowledge the region, ask the type. */
  askUnitTypeWithIntro(lang: Lang, g: Gender, zone: Zone): string {
    return lang === 'en'
      ? `Sure, we have projects ${ZONE_EN[zone]}. Are you after an apartment, a floor, a villa or a townhouse?`
      : `أبشر، عندنا مشاريع ${ZONE_AR[zone]}. ${want(g)} شقة ولا دور ولا فيلا ولا تاون هاوس؟`;
  },

  askUnitType(lang: Lang, g: Gender): string {
    return lang === 'en'
      ? 'Are you after an apartment, a floor, a villa or a townhouse?'
      : `${want(g)} شقة ولا دور ولا فيلا ولا تاون هاوس؟`;
  },

  askBedrooms(lang: Lang, g: Gender): string {
    return lang === 'en' ? 'Good. How many bedrooms?' : `زين، كم غرفة ${want(g)}؟`;
  },

  askBudget(lang: Lang): string {
    return lang === 'en'
      ? "And roughly what's your budget?"
      : 'وكم ميزانيتك تقريباً الله يسلمك؟';
  },

  /** Follows a project card. `outsideZone` = nothing in the asked region, so we say so. */
  afterProject(lang: Lang, zone: Zone | null, outsideZone: boolean, isFirst: boolean): string {
    if (lang === 'en') {
      if (outsideZone && zone) return `Nothing exactly ${ZONE_EN[zone]}, this is the closest to what you want. Does it suit you?`;
      return isFirst ? 'This is the closest to what you asked for. Does it suit you?' : "Here's another option. Does it suit you?";
    }
    if (outsideZone && zone) return `ما لقيت بالضبط ${ZONE_AR[zone]}، هذا أقرب شي لطلبك. ناسبك؟`;
    return isFirst ? 'هذا أقرب شي لطلبك، ناسبك؟' : 'هذا خيار ثاني، ناسبك؟';
  },

  /** Nothing matches at all → a rep takes over (notified). */
  noResults(lang: Lang): string {
    return lang === 'en'
      ? "Sorry, nothing matches exactly right now. A colleague will look and get back to you."
      : 'ما عندنا شي بطلبك بالضبط مع الأسف، بيتواصل معك زميلي ويشوف لك الأنسب.';
  },

  /** We already sent every match → a rep takes over (notified). */
  noMoreResults(lang: Lang): string {
    return lang === 'en'
      ? "Those are our closest options for now. A colleague will look for more and get back to you."
      : 'هذي أقرب الخيارات عندنا حالياً، بيتواصل معك زميلي ويشوف لك غيرها.';
  },

  /** The customer liked a project / wants a visit → a rep arranges it (notified). */
  interested(lang: Lang): string {
    return lang === 'en'
      ? 'Great. A colleague will contact you to arrange a visit.'
      : 'أبشر، بيتواصل معك زميلي ويرتب لك زيارة.';
  },

  /** A question we can't answer from facts, or a request for a person (notified). */
  holding(lang: Lang): string {
    return lang === 'en'
      ? 'Sure, a colleague will contact you shortly.'
      : 'أبشر، بيتواصل معك زميلي في أقرب وقت إن شاء الله.';
  },

  /** The customer isn't interested. */
  close(lang: Lang): string {
    return lang === 'en' ? 'No problem, happy to help anytime.' : 'الله يحييك، في الخدمة 🌹';
  },
};
