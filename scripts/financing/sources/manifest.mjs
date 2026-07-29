/**
 * The official-source manifest for Saudi real-estate financing data.
 *
 * HARD RULE — every entry's `url` must be on an OFFICIAL domain: a regulator
 * (sama.gov.sa, zatca.gov.sa), a government program (sakani.sa, redf.gov.sa),
 * or the provider's own site. Blogs, comparison sites and aggregators are
 * banned as sources of truth; they may only be used by a human to DISCOVER an
 * official URL, which then gets added here.
 *
 * `authority` drives the source-hierarchy ranking stored on every collected
 * value (1 = regulator … 5 = provider site), so a later conflict between two
 * sources resolves toward the higher authority rather than toward whichever
 * ran last.
 */

/** @typedef {'regulator'|'government_program'|'tax_authority'|'provider'|'benchmark'} SourceKind */

export const AUTHORITY = {
  regulator: 1,
  tax_authority: 2,
  government_program: 3,
  benchmark: 4,
  provider: 5,
};

/**
 * Regulatory + program + tax sources. These are the ones that actually publish
 * hard numbers, and they are the backbone of the engine's rule set.
 */
export const REGULATORY_SOURCES = [
  {
    key: 'sama_rlp_chapter_iv',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Responsible Lending Principles for Individual Customers — Chapter IV (Quantitative Principles)',
    title_ar: 'مبادئ الإقراض المسؤول لعملاء الأفراد — الفصل الرابع (المبادئ الكمية)',
    url: 'https://rulebook.sama.gov.sa/en/chapter-iv-quantitative-principles-responsible-lending',
    covers: ['dbr_bands', 'qualifying_income', 'credit_card_treatment', 'salary_deduction'],
  },
  {
    key: 'sama_rlp_full',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Responsible Lending Principles for Individual Customers (entire section)',
    title_ar: 'مبادئ الإقراض المسؤول لعملاء الأفراد (القسم كاملًا)',
    url: 'https://rulebook.sama.gov.sa/en/entiresection/4555',
    covers: ['dbr_bands', 'qualifying_income'],
  },
  {
    key: 'sama_ref_implementing_regulation',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Implementing Regulation of the Real Estate Finance Law',
    title_ar: 'اللائحة التنفيذية لنظام التمويل العقاري',
    url: 'https://rulebook.sama.gov.sa/en/implementing-regulation-real-estate-finance-law',
    covers: ['ltv_base', 'real_estate_finance_rules'],
  },
  {
    key: 'sama_ltv_article_11',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Implementing Regulation of the Real Estate Finance Law — Article 11 (LTV)',
    title_ar: 'اللائحة التنفيذية لنظام التمويل العقاري — المادة 11',
    url: 'https://rulebook.sama.gov.sa/en/article-11-17',
    covers: ['ltv_base'],
  },
  {
    key: 'sama_ltv_circular_2016',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Circular 371000064087 — LTV for real estate finance companies raised to 85%',
    title_ar: 'تعميم ٣٧١٠٠٠٠٦٤٠٨٧ — رفع نسبة التمويل لشركات التمويل العقاري إلى ٨٥٪',
    url: 'https://rulebook.sama.gov.sa/en/change-maximum-ratio-financing-amount-value-property-stated-article-twelve-implementing-regulation',
    covers: ['ltv_finance_companies'],
  },
  {
    key: 'sama_ltv_circular_2018',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Circular 391000048362 — first-home LTV raised to 90% for citizens',
    title_ar: 'تعميم ٣٩١٠٠٠٠٤٨٣٦٢ — رفع نسبة تمويل المسكن الأول للمواطنين إلى ٩٠٪',
    url: 'https://rulebook.sama.gov.sa/en/increase-maximum-mortgage-citizens-own-first-home',
    covers: ['ltv_first_home'],
  },
  {
    key: 'sama_ltv_circular_2017',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Circular 381000039082 — first-home LTV raised to 85% (superseded by the 2018 circular)',
    title_ar: 'تعميم ٣٨١٠٠٠٠٣٩٠٨٢ — رفع نسبة تمويل المسكن الأول إلى ٨٥٪ (ملغى بتعميم ١٤٣٩)',
    url: 'https://rulebook.sama.gov.sa/en/increase-maximum-ltv-real-estate-finance-granted-banks-and-exchangers-citizens-own-first-home',
    covers: ['ltv_first_home_historical'],
  },
  {
    key: 'sama_consumer_financing_regulations',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Regulations for Consumer Financing',
    title_ar: 'لائحة التمويل الاستهلاكي',
    url: 'https://rulebook.sama.gov.sa/en/regulations-consumer-financing',
    covers: ['admin_fee_cap', 'early_settlement', 'apr_disclosure', 'term_cost_definition'],
  },
  {
    key: 'sama_apr_annex',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Annex 1 — Calculation of the Annual Percentage Rate',
    title_ar: 'الملحق ١ — احتساب معدل النسبة السنوية',
    url: 'https://rulebook.sama.gov.sa/en/annex-1-calculation-annual-percentage-rate',
    covers: ['apr_methodology'],
  },
  {
    key: 'sama_apr_rules',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Rules Governing Calculation of the Annual Percentage Rate (APR)',
    title_ar: 'قواعد احتساب معدل النسبة السنوية',
    url: 'https://rulebook.sama.gov.sa/en/rules-governing-calculation-annual-percentage-rate-apr-0',
    covers: ['apr_methodology'],
  },
  {
    key: 'sama_saibor_definition',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Saudi Arabian Benchmark (SAIBOR/SAIBID)',
    title_ar: 'المؤشر السعودي (سايبور/سايبيد)',
    url: 'https://rulebook.sama.gov.sa/en/saudi-arabian-benchmark-saiborsaibid',
    covers: ['benchmark_definition'],
  },
  {
    key: 'sama_licensed_finance_entities',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Finance entities engaging in real estate finance (licensed register)',
    title_ar: 'شركات التمويل الممارسة لنشاط التمويل العقاري',
    url: 'https://www.sama.gov.sa/en-US/Finance/pages/financinglicencedentities.aspx',
    covers: ['provider_register'],
  },
  {
    key: 'sama_licensed_banks',
    kind: 'regulator',
    publisher: 'SAMA',
    title_en: 'Licensed banks operating in Saudi Arabia',
    title_ar: 'البنوك المرخصة العاملة في المملكة',
    url: 'https://www.sama.gov.sa/en-US/Licensing/Pages/LicensedBanks.aspx',
    covers: ['provider_register'],
  },
  {
    key: 'zatca_rett_guideline',
    kind: 'tax_authority',
    publisher: 'ZATCA',
    title_en: 'Real Estate Transaction Tax — detailed guideline',
    title_ar: 'الدليل التفصيلي لضريبة التصرفات العقارية',
    url: 'https://zatca.gov.sa/en/HelpCenter/guidelines/Documents/Detailed-Guideline-for-RETT-In-accordance-with-provision-of-RETT-Law-and-its-Implementing-Regulations.pdf',
    covers: ['rett_rate', 'rett_exemptions'],
    is_pdf: true,
  },
  {
    key: 'zatca_rett_landing',
    kind: 'tax_authority',
    publisher: 'ZATCA',
    title_en: 'Real Estate Transaction Tax',
    title_ar: 'ضريبة التصرفات العقارية',
    url: 'https://zatca.gov.sa/en/RulesRegulations/Taxes/Pages/RealEstate.aspx',
    covers: ['rett_rate', 'rett_exemptions'],
  },
  {
    key: 'sakani_housing_support',
    kind: 'government_program',
    publisher: 'Sakani (MOMRAH / REDF)',
    title_en: 'Sakani — housing support programs',
    title_ar: 'سكني — الدعم السكني',
    url: 'https://sakani.sa/app/housing-support',
    covers: ['support_programs'],
    settle_ms: 12000,
  },
  {
    key: 'redf_home',
    kind: 'government_program',
    publisher: 'Real Estate Development Fund',
    title_en: 'Real Estate Development Fund',
    title_ar: 'صندوق التنمية العقارية',
    url: 'https://www.redf.gov.sa/en',
    covers: ['support_programs'],
    settle_ms: 10000,
  },
];

/**
 * Provider product sources. `provider_key` groups many product pages under one
 * provider row. Discovering these URLs is a human/agent step; keeping them here
 * makes the refresh reproducible.
 */
export const PROVIDER_SOURCES = [
  // ── Al Rajhi Bank ───────────────────────────────────────────────────────
  { key: 'alrajhi_home_finance', provider_key: 'alrajhi', kind: 'provider', publisher: 'Al Rajhi Bank',
    title_en: 'Home Finance', url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Home-Finance' },
  { key: 'alrajhi_off_plan', provider_key: 'alrajhi', kind: 'provider', publisher: 'Al Rajhi Bank',
    title_en: 'Off-Plan', url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/off-plan' },
  { key: 'alrajhi_flexible', provider_key: 'alrajhi', kind: 'provider', publisher: 'Al Rajhi Bank',
    title_en: 'Flexible Finance Product', url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Flexible-Finance-Product' },
  { key: 'alrajhi_buyout', provider_key: 'alrajhi', kind: 'provider', publisher: 'Al Rajhi Bank',
    title_en: 'Buyout Home Finance', url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Buyout-Home-Finance' },
  { key: 'alrajhi_property_power', provider_key: 'alrajhi', kind: 'provider', publisher: 'Al Rajhi Bank',
    title_en: 'Property Power', url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Property-Power' },
  { key: 'alrajhi_tharwa', provider_key: 'alrajhi', kind: 'provider', publisher: 'Al Rajhi Bank',
    title_en: 'Tharwa real estate financing', url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Tharwa' },
  // Surfaced 2026-07-29 — a resident-specific product the first pass missed.
  { key: 'alrajhi_expat', provider_key: 'alrajhi', kind: 'provider', publisher: 'Al Rajhi Bank',
    title_en: 'Expat Home Finance', url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Expat-Home-Finance' },

  // ── Saudi National Bank ─────────────────────────────────────────────────
  { key: 'snb_home_finance', provider_key: 'snb', kind: 'provider', publisher: 'Saudi National Bank',
    title_en: 'Residential Finance', url: 'https://www.alahli.com/en/pages/personal-banking/finance/home-finance' },
  { key: 'snb_murabaha_home', provider_key: 'snb', kind: 'provider', publisher: 'Saudi National Bank',
    title_en: 'Murabaha Residential Finance', url: 'https://www.alahli.com/en/pages/personal-banking/finance/murabaha-home-finance' },
  { key: 'snb_pricing', provider_key: 'snb', kind: 'provider', publisher: 'Saudi National Bank',
    title_en: 'Finance & Saving Pricing', url: 'https://www.alahli.com/en/pages/personal-banking/finance/finance-and-saving-pricing' },
  { key: 'snb_residential_products', provider_key: 'snb', kind: 'provider', publisher: 'Saudi National Bank',
    title_en: '2-in-1 residential finance products', url: 'https://www.alahli.com/en/pages/personal-banking/finance/home-finance/residential-finance-products' },

  // ── Riyad Bank ──────────────────────────────────────────────────────────
  // URL paths corrected 2026-07-29. The earlier guesses 404'd; these came from
  // searching riyadbank.com itself after a comparison site confirmed the bank
  // does publish residential products (the aggregator was useless as DATA, but
  // useful as a pointer to go look again).
  { key: 'riyad_home_finance', provider_key: 'riyad', kind: 'provider', publisher: 'Riyad Bank',
    title_en: 'Home finance', url: 'https://www.riyadbank.com/personal-banking/home-finance' },
  { key: 'riyad_readymade', provider_key: 'riyad', kind: 'provider', publisher: 'Riyad Bank',
    title_en: 'Purchasing ready-made property', url: 'https://www.riyadbank.com/personal-banking/home-loan/readymade-property-finance' },
  { key: 'riyad_off_plan', provider_key: 'riyad', kind: 'provider', publisher: 'Riyad Bank',
    title_en: 'Off-plan programs (Housing Ministry)', url: 'https://www.riyadbank.com/personal/borrow/home-loan/off-plan-programs-housing-ministry' },
  { key: 'riyad_home_equity', provider_key: 'riyad', kind: 'provider', publisher: 'Riyad Bank',
    title_en: 'Home equity program', url: 'https://www.riyadbank.com/personal-banking/home-loan/home-equity-program' },
  { key: 'riyad_redf', provider_key: 'riyad', kind: 'provider', publisher: 'Riyad Bank',
    title_en: 'REDF-supported financing', url: 'https://www.riyadbank.com/redf' },
  // The bank's OWN APR disclosure — the highest-value kind of provider source,
  // because a published APR schedule is a pricing disclosure rather than
  // marketing copy. Linked from the product page as "Home Finance APR disclosure".
  { key: 'riyad_apr_disclosure', provider_key: 'riyad', kind: 'provider', publisher: 'Riyad Bank',
    title_en: 'Prices of financing and savings products (APR disclosure)',
    url: 'https://www.riyadbank.com/information/special-pages/arp-disclosure', settle_ms: 12000, timeout_ms: 120000 },

  // ── Alinma Bank ─────────────────────────────────────────────────────────
  { key: 'alinma_real_estate', provider_key: 'alinma', kind: 'provider', publisher: 'Alinma Bank',
    title_en: 'Alinma real estate financing', url: 'https://www.alinma.com/Retail/Financing/alinma-Real-Estate-Financing' },

  // ── Bank Albilad ────────────────────────────────────────────────────────
  { key: 'albilad_real_estate', provider_key: 'albilad', kind: 'provider', publisher: 'Bank Albilad',
    title_en: 'Real estate financing', url: 'https://www.bankalbilad.com/en/personal/financing/real-estate' },
  { key: 'albilad_index', provider_key: 'albilad', kind: 'provider', publisher: 'Bank Albilad',
    title_en: 'Personal financing index', url: 'https://www.bankalbilad.com/en/personal/financing' },

  // ── Banque Saudi Fransi ─────────────────────────────────────────────────
  // The English path was permission-denied; the ARABIC tree serves the product
  // pages fine. Corrected 2026-07-29.
  { key: 'bsf_home_finance_products', provider_key: 'bsf', kind: 'provider', publisher: 'Banque Saudi Fransi',
    title_en: 'Home finance products index', title_ar: 'التمويل العقاري',
    url: 'https://bsf.sa/arabic/personal/finance/home-finance-products' },
  { key: 'bsf_mortgage', provider_key: 'bsf', kind: 'provider', publisher: 'Banque Saudi Fransi',
    title_en: 'Mortgage product', title_ar: 'منتج الرهن العقاري',
    url: 'https://bsf.sa/arabic/personal/finance/home-finance-products/mortgage' },
  { key: 'bsf_off_plan', provider_key: 'bsf', kind: 'provider', publisher: 'Banque Saudi Fransi',
    title_en: 'Off-plan units', title_ar: 'منتج الوحدات تحت الإنشاء',
    url: 'https://bsf.sa/arabic/personal/finance/home-finance-products/off-plan-product' },
  { key: 'bsf_incomplete', provider_key: 'bsf', kind: 'provider', publisher: 'Banque Saudi Fransi',
    title_en: 'Incomplete property', title_ar: 'منتجات التمويل العقاري — العقار غير المكتمل',
    url: 'https://bsf.sa/arabic/personal/finance/home-finance-products/incomplete-property' },
  { key: 'bsf_buyout', provider_key: 'bsf', kind: 'provider', publisher: 'Banque Saudi Fransi',
    title_en: 'Buyout of real estate debt', title_ar: 'منتج سداد المديونية العقارية',
    url: 'https://bsf.sa/arabic/personal/finance/home-finance-products/buyout-home-loan-product' },
  { key: 'bsf_subsidized', provider_key: 'bsf', kind: 'provider', publisher: 'Banque Saudi Fransi',
    title_en: 'Subsidised financing / Al Moyassar mortgage', title_ar: 'برنامج القرض العقاري المدعوم',
    url: 'https://bsf.sa/arabic/personal/finance/home-finance-products/subsidized-financing-amp-al-moyassar-mortgage' },
  { key: 'bsf_ready_units', provider_key: 'bsf', kind: 'provider', publisher: 'Banque Saudi Fransi',
    title_en: 'Ready units purchase', title_ar: 'منتج شراء الوحدات الجاهزة',
    url: 'https://bsf.sa/arabic/personal/finance/home-finance-products/tawaruq-personal-finance' },
  { key: 'bsf_saibor', provider_key: 'bsf', kind: 'benchmark', publisher: 'Banque Saudi Fransi',
    title_en: 'SAIBOR index (bank disclosure)', url: 'https://bsf.sa/english/personal/finance/saibor-index' },

  // ── Saudi Awwal Bank ────────────────────────────────────────────────────
  { key: 'sab_home_products', provider_key: 'sab', kind: 'provider', publisher: 'Saudi Awwal Bank',
    title_en: 'Home finance products', url: 'https://www.sab.com/en/personal/finance/home-finance-products/' },
  { key: 'sab_subsidised', provider_key: 'sab', kind: 'provider', publisher: 'Saudi Awwal Bank',
    title_en: 'REDF-subsidised mortgage', url: 'https://www.sab.com/en/personal/finance/home-finance-products/ministry-products/government-subsides-product/subsidized-mortgage/' },

  // ── Arab National Bank ──────────────────────────────────────────────────
  // Paths corrected 2026-07-29 (the earlier guess hit a maintenance page).
  { key: 'anb_real_estate', provider_key: 'anb', kind: 'provider', publisher: 'Arab National Bank',
    title_en: 'Real estate finance solutions', title_ar: 'حلول التمويل العقاري',
    url: 'https://anb.com.sa/web/anb/real-estate' },
  { key: 'anb_mubarak_home', provider_key: 'anb', kind: 'provider', publisher: 'Arab National Bank',
    title_en: 'Al Mubarak Home Finance', title_ar: 'تمويل المنزل المبارك',
    url: 'https://www.anb.com.sa/ar/Personal/FinancePrograms/RealEstateFinance' },

  // ── Bank AlJazira ───────────────────────────────────────────────────────
  { key: 'aljazira_real_estate', provider_key: 'aljazira', kind: 'provider', publisher: 'Bank AlJazira',
    title_en: 'Real estate finance application', title_ar: 'التمويل العقاري',
    url: 'https://www.bankaljazira.com/Personal-Banking/Finance/Real-Estate-Finance-Application' },
  { key: 'aljazira_adjustable', provider_key: 'aljazira', kind: 'provider', publisher: 'Bank AlJazira',
    title_en: 'Adjustable-repayment mortgage', title_ar: 'التمويل العقاري بقسط متغير',
    url: 'https://www.bankaljazira.com/ar-sa/Personal-Banking/Finance/Real-Estate-Finance/Adjustable-Repayment-Mortgage' },
  { key: 'aljazira_subsidized_offplan', provider_key: 'aljazira', kind: 'provider', publisher: 'Bank AlJazira',
    title_en: 'Subsidised housing programs — off-plan', title_ar: 'برامج التمويل السكني المدعوم — البيع على الخارطة',
    url: 'https://www.bankaljazira.com/ar-sa/Personal-Banking/Finance/Real-Estate-Finance/Subsidized-Funding-Program/-Off-plan-Program' },

  // ── The Saudi Investment Bank ───────────────────────────────────────────
  { key: 'saib_alasalah_home', provider_key: 'saib', kind: 'provider', publisher: 'The Saudi Investment Bank',
    title_en: 'Alasalah Home Finance', title_ar: 'تمويل الأصالة العقاري',
    url: 'https://www.saib.com.sa/en/al-asalah-home-finance' },
  { key: 'saib_rates', provider_key: 'saib', kind: 'provider', publisher: 'The Saudi Investment Bank',
    title_en: 'Prices of financing & savings products',
    url: 'https://www.saib.com.sa/en/prices-financing-and-savings-products', settle_ms: 9000 },

  // ── First Abu Dhabi Bank (foreign bank licensed in KSA) ─────────────────
  // Added 2026-07-29. The spec asked for foreign banks offering eligible retail
  // financing; FAB was missing from the provider list entirely until a
  // comparison listing surfaced it and its own KSA site confirmed a presence.
  { key: 'fab_ksa_personal', provider_key: 'fab', kind: 'provider', publisher: 'First Abu Dhabi Bank',
    title_en: 'FAB Saudi Arabia — personal banking', url: 'https://www.bankfab.com/en-sa/personal' },
  { key: 'fab_ksa_about', provider_key: 'fab', kind: 'provider', publisher: 'First Abu Dhabi Bank',
    title_en: 'FAB Saudi Arabia', url: 'https://www.bankfab.com/en-sa/about-us' },

  // ── Licensed real-estate finance companies ──────────────────────────────
  { key: 'bidaya_products', provider_key: 'bidaya', kind: 'provider', publisher: 'Bidaya Home Finance',
    title_en: 'Bidaya home finance products', url: 'https://www.bidaya.com.sa/en/products' },
  { key: 'dgf_products', provider_key: 'deutsche_gulf', kind: 'provider', publisher: 'Deutsche Gulf Finance',
    title_en: 'Deutsche Gulf Finance home finance', url: 'https://www.dgf.com.sa/en/' },
  { key: 'amlak_products', provider_key: 'amlak', kind: 'provider', publisher: 'Amlak International',
    title_en: 'Amlak International real estate finance', url: 'https://www.amlak.com.sa/en/individuals' },
  { key: 'dar_altamleek_products', provider_key: 'dar_altamleek', kind: 'provider', publisher: 'Dar Al Tamleek',
    title_en: 'Dar Al Tamleek products', url: 'https://www.daraltamleek.com/en/' },
  { key: 'shl_products', provider_key: 'saudi_home_loans', kind: 'provider', publisher: 'Saudi Home Loans',
    title_en: 'Saudi Home Loans products', url: 'https://www.saudihomeloans.com/en/' },
  { key: 'src_home', provider_key: 'src', kind: 'provider', publisher: 'Saudi Real Estate Refinance Company',
    title_en: 'SRC (refinance / secondary market)', url: 'https://srco.com.sa/en' },
];

export const ALL_SOURCES = [...REGULATORY_SOURCES, ...PROVIDER_SOURCES];

export function sourceByKey(key) {
  return ALL_SOURCES.find((s) => s.key === key) ?? null;
}
