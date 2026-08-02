// mos-qa-setups.mjs — setup-recipe registry for the Marketing OS visual gate.
//
// Each recipe takes the manifest row from a booted, authenticated, deterministic
// page to the exact app state the row's reference frame depicts. Recipes are
// named by coverage-matrix.mjs `setup` keys; scripts/mos-qa.mjs looks the key
// up here and FAILS LOUDLY as 'no-setup' when it is absent — an unimplemented
// recipe is never stubbed with a fake pass.
//
// ctx (built by mos-qa.mjs):
//   page               — puppeteer Page: authenticated, correct locale/theme/
//                        viewport, time frozen, app already booted at appUrl+'/m'
//   appUrl             — e.g. http://localhost:3000
//   row                — the manifest row (route may contain :token ids)
//   role               — the row's effective role (after @role= parsing)
//   api(action, data)  — POST /api/marketing-os with this row's role token;
//                        throws on HTTP errors and error envelopes
//   resolveRef(kind, ref) — fixture ref → live id, per-run cached:
//                        'content' (V-004…), 'campaign' (C-002…), 'shoot'
//                        (SR-003, with the documented SH- allocator fallback),
//                        'asset' (by title or ref)
//   resolveRoute(route)— replaces ':v004'-style tokens: FIXTURE_IDS env
//                        overrides first, resolveRef conventions otherwise;
//                        THROWS on an unresolvable token
//   goto(path)         — page.goto(appUrl + path, networkidle0), then waits for
//                        document.fonts.ready + a 500ms settle
//
// Conventions:
//   - Everything is locale-aware: EN mirror rows (locale 'en') click English
//     labels. Data strings (titles, refs, scene names) are locale-independent.
//   - Every interactive recipe ends by waiting for a DISTINCTIVE text from the
//     mockup, then fonts.ready + 400ms. A state the app cannot produce throws —
//     it is never faked.

/**
 * Fixture-record ids the routes point at. Real ids are resolved live through
 * ctx.resolveRef; these env overrides (MOS_FIXTURE_IDS_JSON) win when set.
 * An empty default is deliberate: a route token with no fixture id falls back
 * to the live resolution, and a token that resolves to nothing throws — the
 * row fails loudly instead of navigating to a nonsense URL.
 */
export const FIXTURE_IDS = {
  ...{
    // v004 / v001 — content records; p013 — project; c002 — campaign;
    // e1 — campaign execution; a012 — library asset; sr003 — shoot request.
    v004: null, v001: null, p013: null, c002: null, e1: null, a012: null, sr003: null,
  },
  ...(process.env.MOS_FIXTURE_IDS_JSON ? JSON.parse(process.env.MOS_FIXTURE_IDS_JSON) : {}),
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fonts.ready + 400ms — the post-click counterpart of ctx.goto's settle. */
async function settle(ctx) {
  await ctx.page.evaluate(() => document.fonts.ready);
  await sleep(400);
}

/** Locale-picked label: the row's locale decides which UI string to match. */
const L = (ctx, ar, en) => (ctx.row.locale === 'ar' ? ar : en);

/** Wait until the page's visible text contains `text` (distinctive mockup text). */
async function waitText(ctx, text, timeout = 15000) {
  await ctx.page.waitForFunction(
    (t) => (document.body?.innerText ?? '').includes(t),
    { timeout },
    text,
  );
}

/** Find a clickable element by its (normalized) text. */
async function findClickable(ctx, text, { selector = 'button', exact = false } = {}) {
  const handle = await ctx.page.evaluateHandle(
    (sel, t, ex) =>
      [...document.querySelectorAll(sel)].find((e) => {
        const txt = (e.textContent ?? '').replace(/\s+/g, ' ').trim();
        return ex ? txt === t : txt.includes(t);
      }) ?? null,
    selector,
    text,
    exact,
  );
  return handle.asElement();
}

/** Click an element by text — throws loudly when it is not there. */
async function clickText(ctx, text, opts = {}) {
  const el = await findClickable(ctx, text, opts);
  if (!el) {
    throw new Error(
      `setup '${ctx.row.setup}': no clickable '${opts.selector ?? 'button'}' ` +
      `${opts.exact ? 'exactly' : 'containing'} «${text}» (row ${ctx.row.id})`,
    );
  }
  await el.click();
}

/** The row's route with fixture tokens resolved, then navigated to. */
const gotoRoute = async (ctx) => ctx.goto(await ctx.resolveRoute(ctx.row.route));

/** Navigation-only recipes: reach the route, the screen loads its own data. */
const navOnly = (ctx) => gotoRoute(ctx);

/**
 * Shared base for the s30 recipes: the shoot's site-mode screen. The route
 * (?mode=site) has no app handler yet and falls through to /m — the wait then
 * throws, loudly.
 */
async function siteMode(ctx) {
  await gotoRoute(ctx);
  try {
    // The shoot's own title only renders on its screen — never on /m.
    await waitText(ctx, 'خارجيات', 8000);
  } catch {
    throw new Error(
      'mobile site mode: /m/shoots/:id?mode=site did not render the shot list — ' +
      'site mode is not implemented (the route redirected to /m).',
    );
  }
}

/**
 * Content/campaign detail tabs are LOCAL STATE in the app (the ?tab= query is
 * ignored), so recipes click the tab button by its label and confirm it turned
 * on. `wait` optionally names distinctive content text of the target tab.
 */
async function clickTab(ctx, label, wait) {
  await clickText(ctx, label, { selector: '.tabs button' });
  await ctx.page.waitForFunction(
    (l) =>
      [...document.querySelectorAll('.tabs button')].some(
        (b) => b.classList.contains('on')
          && (b.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(l),
      ),
    { timeout: 8000 },
    label,
  );
  if (wait) await waitText(ctx, wait);
  await settle(ctx);
}

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */

export const SETUPS = {
  /* ── navigation-only ─────────────────────────────────────────────── */

  'overview-loaded': navOnly,
  'mywork-writer': navOnly,
  'content-table': navOnly,
  'content-table-en': navOnly,
  'content-board': navOnly,
  'campaigns-list': navOnly,
  'calendar-month': navOnly,
  'library-grid': navOnly,
  'library-unused': navOnly,
  'shoots-bands': navOnly,
  'settings-home': navOnly,
  'settings-platforms': navOnly,
  'settings-role-matrix': navOnly,
  'settings-people': navOnly,
  'settings-notifications': navOnly,
  'numbers-weekly-entry': navOnly,
  'team-followup': navOnly,
  'c002-detail': navOnly,
  'c002-exec-detail': navOnly,
  'asset-detail': navOnly,
  'shoot-request-detail': navOnly,
  'mobile-account': navOnly,
  // s45 — the truthful empty state. The operator runs this AFTER
  // `node scripts/mos-fixtures.mjs --teardown`; the recipe itself never
  // tears anything down.
  'zero-records-day-one': navOnly,

  // s34 — the CEO's overview. The role comes from the row; /m renders it.
  'overview-ceo': navOnly,

  // s36 — one record, five role states. Same capture as v004-overview;
  // the role (and therefore the button/lock set) comes from the row.
  'v004-role-harness': navOnly,

  /* ── s44 search — the route carries ?q=مينا; wait for the results ── */

  'search-results': async (ctx) => {
    await gotoRoute(ctx);
    // Fixture data text («مينا ٥٢») appears only once results have rendered.
    await waitText(ctx, 'مينا ٥٢');
    await settle(ctx);
  },

  /* ── s05 — new content modal ─────────────────────────────────────── */

  'new-content-modal': async (ctx) => {
    await gotoRoute(ctx);
    await clickText(ctx, L(ctx, 'محتوى جديد', 'New content'), { exact: true });
    await ctx.page.waitForSelector('.modal[role=dialog]', { timeout: 8000 });
    await waitText(ctx, L(ctx, 'إنشاء وإسناد', 'Create and assign'));
    await settle(ctx);
  },

  /* ── s19 — new campaign modal ────────────────────────────────────── */

  'new-campaign-modal': async (ctx) => {
    await gotoRoute(ctx);
    await clickText(ctx, L(ctx, 'حملة جديدة', 'New campaign'), { exact: true });
    await ctx.page.waitForSelector('.modal[role=dialog]', { timeout: 8000 });
    await settle(ctx);
  },

  /* ── s38 — request-changes modal (approver: V-004 sits at مراجعة النص) ── */

  'request-changes-modal': async (ctx) => {
    await gotoRoute(ctx);
    // The TaskCard lives on the (default) overview tab; its reject button
    // opens the modal. Exact match — «المهام والاعتمادات» also contains اعتماد.
    await clickText(ctx, L(ctx, 'طلب تعديلات', 'Request changes'), {
      selector: '.task-card button', exact: true,
    });
    await ctx.page.waitForSelector('.modal[role=dialog]', { timeout: 8000 });
    await waitText(ctx, L(ctx, 'ما الذي يجب تغييره؟', 'What needs to change?'));
    // s38 shows the note already written. Typing it is non-destructive —
    // the modal stays open and nothing is submitted.
    await ctx.page.type(
      '.modal[role=dialog] textarea',
      'المشهد ٣ ما زال يشرح الموقع بدل أن يُظهره — اجعليه لقطة خريطة متحركة بلا تعليق. والتعليق الصوتي أطول من الصورة بأربع ثوانٍ.',
    );
    await settle(ctx);
  },

  /* ── s06–s12 — content detail tabs ───────────────────────────────── */

  'v004-overview': async (ctx) => {
    await gotoRoute(ctx);
    await waitText(ctx, 'مينا ٥٢ — جولة الموقع');
    await settle(ctx);
  },

  // s07 — the writing tab («المحتوى»), V-004's scenes readable.
  'v004-writing': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'المحتوى', 'Content'), 'كاميرا سيارة');
  },

  // s08 — the same tab for a post.
  'p013-writing': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'المحتوى', 'Content'));
  },

  // s09 — المواد والملفات; V-004's linked source asset proves the tab loaded.
  'v004-materials': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'المواد', 'Material'), 'اقتراب ليلي خارجي');
  },

  // s10 — المهام والاعتمادات; the round column is distinctive to this tab.
  'v004-tasks': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'المهام والاعتمادات', 'Tasks & approvals'), L(ctx, 'الجولة', 'Round'));
  },

  // s11 — النشر for a published item.
  'v001-publish': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'النشر', 'Publishing'), L(ctx, 'خطة النشر', 'Publishing plan'));
  },

  // s12 — الأداء with manually-entered readings (the fixture snapshots).
  'v001-performance-manual': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'الأداء', 'Performance'), L(ctx, 'لكل منصة', 'By platform'));
  },

  // s12 substate — the same tab fed by CONNECTED (platform-sourced) data.
  // The fixtures only record manual readings (metrics_record hardcodes
  // source='manual' in api/marketing-os.ts) and the tab has no
  // manual/connected toggle — so verify the data exists via the API and
  // refuse to fake the state when it does not.
  'v001-performance-connected': async (ctx) => {
    const v001 = await ctx.resolveRef('content', 'V-001');
    const pubs = await ctx.api('publication_list', { content_id: v001 });
    let connected = false;
    for (const p of pubs.publications ?? []) {
      const h = await ctx.api('metrics_history', { publication_id: p.id });
      if ((h.snapshots ?? []).some((s) => s.source && s.source !== 'manual')) {
        connected = true;
        break;
      }
    }
    if (!connected) {
      throw new Error(
        'v001-performance-connected: impossible to produce honestly — the fixtures ' +
        'record only manual readings (metrics_record → source=manual) and the ' +
        'Performance tab has no connected/manual toggle. Add platform-sourced ' +
        'snapshots to the fixtures before this row can be captured.',
      );
    }
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'الأداء', 'Performance'), L(ctx, 'من المنصة', 'from platform'));
  },

  /* ── s20 / s39 / s40 — campaign detail tabs ──────────────────────── */

  'c002-executions': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'التنفيذات', 'Executions'), 'إطلاق ميتا');
  },

  'c002-content-tab': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'المحتوى', 'Content'), 'V-001');
  },

  'c002-results-tab': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'النتائج', 'Results'), L(ctx, 'النتيجة لكل منصة', 'Result by platform'));
  },

  /* ── s17 — workflow editor: the approval step opened for editing ──── */

  'workflows-editor': async (ctx) => {
    await gotoRoute(ctx);
    // s17 shows the FIRST workflow's SECOND step (مراجعة الفكرة — the
    // approval step) expanded «قيد التعديل». The app opens that editor in a
    // modal via the step's «تعديل» button.
    const clicked = await ctx.page.evaluate((editLabel) => {
      const steps = [...document.querySelectorAll('.wstep')];
      const target = steps[1] ?? steps[0];
      if (!target) return false;
      const btn = [...target.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === editLabel);
      if (!btn) return false;
      btn.click();
      return true;
    }, L(ctx, 'تعديل', 'Edit'));
    if (!clicked) {
      throw new Error(`workflows-editor: no workflow-step «${L(ctx, 'تعديل', 'Edit')}» button found (row ${ctx.row.id})`);
    }
    await ctx.page.waitForSelector('.modal[role=dialog]', { timeout: 8000 });
    await waitText(ctx, L(ctx, 'تعديل المرحلة', 'Edit stage'));
    await settle(ctx);
  },

  /* ── s27 — content types: the first type's editor is open by default ── */

  'settings-content-types': async (ctx) => {
    await gotoRoute(ctx);
    await waitText(ctx, L(ctx, 'أنواع المحتوى', 'Content types'));
    await settle(ctx);
  },

  /* ── s23 — upload queue, synthesized client-side ──────────────────── */

  'upload-queue-realism': async (ctx) => {
    await ctx.goto('/m/library/upload');

    // The s23 frame shows the batch linked to a shoot request. The only OPEN
    // fixture request is «مينا ٥٢ — الدائري والمدارس» (SH-005; SH-003/004 are
    // delivered). Selecting it also renders the «مرتبط بطلب التصوير» note.
    const linked = await ctx.page.evaluate(() => {
      const sel = [...document.querySelectorAll('select.inp')].find((s) =>
        [...s.options].some((o) => (o.textContent ?? '').includes('الدائري')));
      if (!sel) return false;
      const opt = [...sel.options].find((o) => (o.textContent ?? '').includes('الدائري'));
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    if (!linked) {
      throw new Error('upload-queue-realism: the open shoot «الدائري والمدارس» is not in the shoot select — fixtures missing?');
    }
    await waitText(ctx, L(ctx, 'مرتبط بطلب التصوير', 'Linked to shoot request'));

    // The visible queue rows, transcribed from s23 (IMG_4482/4483 done,
    // IMG_4491 a duplicate, DJI_0114 mid-upload) plus enough siblings to fill
    // the list — 12 small generated blobs, NOT 184 real files. Sizes differ
    // so the name|size dedupe keeps every row.
    const NAMES = [
      'IMG_4482.HEIC', 'IMG_4483.HEIC', 'IMG_4484.HEIC', 'IMG_4485.HEIC',
      'IMG_4486.HEIC', 'IMG_4487.HEIC', 'IMG_4488.HEIC', 'IMG_4489.HEIC',
      'IMG_4490.HEIC', 'IMG_4491.HEIC', 'DJI_0114.MOV', 'DJI_0115.MOV',
    ];
    await ctx.page.evaluate((names) => {
      const dt = new DataTransfer();
      for (const [i, n] of names.entries()) {
        const isMov = n.endsWith('.MOV');
        const bytes = new Uint8Array(2048 + i * 137); // distinct, tiny
        dt.items.add(new File([bytes], n, { type: isMov ? 'video/quicktime' : 'image/heic' }));
      }
      const drop = document.querySelector('.drop');
      if (!drop) throw new Error('upload dropzone (.drop) not found');
      drop.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, NAMES);
    await ctx.page.waitForFunction(
      (n) => document.querySelectorAll('.file').length >= n,
      { timeout: 10000 },
      NAMES.length,
    );
    await settle(ctx);
  },

  /* ── mobile screens (s28–s33, s46, s48–s52) ───────────────────────── */
  /* The viewport is already mobile (from the row). Pure-navigation mobile  */
  /* recipes are navOnly; the ones below drive a further in-screen state.   */

  // s28 — اليوم، والبحث (both phones capture the my-work screen).
  'mobile-today': navOnly,
  // s29 phone1 — the lock-screen push notification frame. The closest
  // app-side state is the item the notification points at.
  'mobile-review-push': navOnly,
  // s29 phone2 — reading the script with the scene list.
  'mobile-review-scenes': navOnly,
  // s32 — campaign execution cards on a phone.
  'mobile-exec-cards': navOnly,
  // s48 phone2 — campaign verdicts list on a phone.
  'mobile-campaign-verdicts': navOnly,
  // s49 — the calendar's agenda reading on a phone.
  'mobile-calendar-agenda': navOnly,
  // s49 phone2 — the roles list on a phone.
  'mobile-roles-list': navOnly,
  // s51 — the workflow accordion on a phone.
  'mobile-workflow-accordion': navOnly,
  // s51 phone2 — the library grid on a phone.
  'mobile-library-grid': navOnly,
  // s52 phone2 — the overview cards stacked on a phone.
  'mobile-overview-stack': navOnly,

  // s29 phone3 — the approval bottom sheet («اعتماد هذا النص؟»). Desktop's
  // TaskCard approves immediately, so if no sheet appears the click has
  // already committed — the throw says so, loudly.
  'mobile-review-sheet': async (ctx) => {
    await gotoRoute(ctx);
    await clickText(ctx, L(ctx, 'اعتماد', 'Approve'), { selector: '.task-card button', exact: true });
    try {
      await waitText(ctx, L(ctx, 'اعتماد هذا النص', 'Approve this'), 3000);
    } catch {
      throw new Error(
        'mobile-review-sheet: clicking «اعتماد» did not open the approval sheet ' +
        '(«اعتماد هذا النص؟») — the mobile review sheet is not implemented. NOTE: ' +
        'the click may have APPROVED V-004\'s open task; re-run ' +
        'node scripts/mos-fixtures.mjs before capturing other V-004 rows.',
      );
    }
    await settle(ctx);
  },

  // s48 phone1 — the «المزيد» tab-bar sheet. There is no mobile tab bar in
  // the workspace yet, so the clickText throw IS the loud failure.
  'mobile-more-sheet': async (ctx) => {
    await gotoRoute(ctx);
    await clickText(ctx, L(ctx, 'المزيد', 'More'));
    await settle(ctx);
  },

  // s31 — the publish-assistant sheet («حان وقت النشر»). The Publishing tab
  // has no assistant trigger yet — throw rather than fake it with the edit
  // publication modal.
  'mobile-publish-assistant': async (ctx) => {
    await gotoRoute(ctx);
    await clickTab(ctx, L(ctx, 'النشر', 'Publishing'));
    const trigger = await findClickable(ctx, L(ctx, 'مساعد النشر', 'Publish assistant'));
    if (!trigger) {
      throw new Error(
        'mobile-publish-assistant: no «مساعد النشر» trigger on the Publishing tab — ' +
        'the assistant sheet is not implemented.',
      );
    }
    await trigger.click();
    await waitText(ctx, L(ctx, 'حان وقت النشر', 'Time to publish'), 5000);
    await settle(ctx);
  },

  // s52 phone1 — the one-at-a-time weekly-numbers entry. NumbersPage is the
  // single grid today; there is no one-at-a-time mode to start — throw.
  'mobile-numbers-task': async (ctx) => {
    await gotoRoute(ctx);
    const trigger = await findClickable(ctx, L(ctx, 'ابدأ الإدخال', 'Start entry'));
    if (!trigger) {
      throw new Error(
        'mobile-numbers-task: no one-at-a-time entry mode on the Numbers screen — ' +
        'the «عنصر واحد في كل مرة» flow is not implemented.',
      );
    }
    await trigger.click();
    await waitText(ctx, L(ctx, 'التالي', 'Next'), 5000);
    await settle(ctx);
  },

  /* ── s30 — on-site shooting mode ───────────────────────────────────── */

  // s30 phone1 — the shot list in the field.
  'mobile-site-shoot': async (ctx) => {
    await siteMode(ctx);
    await settle(ctx);
  },
  'mobile-site-list': async (ctx) => {
    await siteMode(ctx);
    await settle(ctx);
  },

  // s30 phone2 — no bars on site: tick one item OFFLINE so the queued chip
  // renders, then restore the network whatever happens.
  'mobile-site-offline': async (ctx) => {
    await siteMode(ctx);
    await ctx.page.emulateNetworkConditions({
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    try {
      await clickText(ctx, 'كاميرا سيارة', { selector: '.chk' });
      await waitText(ctx, L(ctx, 'سيُرفع', 'queued'), 5000);
    } catch (err) {
      throw new Error(`mobile-site-offline: ticking a shot offline did not render the queued chip — ${err.message}`);
    } finally {
      await ctx.page.emulateNetworkConditions({
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
    }
    await settle(ctx);
  },
};

// Recipes needing modals, fixtures, or seeded state live above. Do NOT add a
// key without a real recipe — an absent key is how the harness reports
// 'no-setup', and a faked state is worse than a loud one.
