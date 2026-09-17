/**
 * Real Wassel project imagery for the recruitment intro carousel.
 *
 * Each project's `main_image` was resolved from the private `wassel-files`
 * bucket and re-hosted to the public `hire-assets/projects/` bucket (same
 * pattern as the intro video) so a public, no-auth candidate page can show real
 * project photos without exposing private storage. Names + cities are the real
 * records (our_projects across Riyadh and Dubai).
 */
export interface HireProject {
  name: string;
  city: string;
  url: string;
}

const B = 'https://zhqqsxwealdwqzrbpwyv.supabase.co/storage/v1/object/public/hire-assets/projects/';

// Interleaved Riyadh / Dubai so the range of options is obvious at a glance.
export const CAROUSEL_PROJECTS: HireProject[] = [
  { name: 'صفا 20', city: 'الرياض', url: `${B}safa20.jpg` },
  { name: 'بن غاطي سكاي رايز', city: 'دبي', url: `${B}skyrise.jpg` },
  { name: 'دروازة', city: 'الرياض', url: `${B}derwaza.jpg` },
  { name: 'بوغاتي رزيدنسز', city: 'دبي', url: `${B}bugatti.jpg` },
  { name: 'فلل رِفان', city: 'الرياض', url: `${B}rifan.jpg` },
  { name: 'بن غاطي غروف', city: 'دبي', url: `${B}grove.jpg` },
  { name: 'تل الربوة', city: 'الرياض', url: `${B}talrabwa.png` },
  { name: 'ون باي بن غاطي', city: 'دبي', url: `${B}onebinghatti.jpg` },
];

// The two matching recommendations shown in the section-2 overview — real
// Riyadh villa projects that fit the fictional customer's preferences.
export const OVERVIEW_RECS = [
  { name: 'صفا 20', city: 'الرياض', district: 'شمال الرياض', url: `${B}safa20.jpg`, price: '1.9م – 2.2م ر.س', band: 'مطابقة قوية · 94' },
  { name: 'دروازة', city: 'الرياض', district: 'شمال الرياض', url: `${B}derwaza.jpg`, price: '1.7م – 2.0م ر.س', band: 'مطابقة جيدة · 88' },
];

// The one project whose material is "sent" in the section-2 WhatsApp preview.
export const OVERVIEW_SEND_PROJECT = { name: 'صفا 20', url: `${B}safa20.jpg` };
