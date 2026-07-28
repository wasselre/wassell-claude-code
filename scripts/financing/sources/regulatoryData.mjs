/**
 * Reviewed regulatory / tax / benchmark data, extracted from the official
 * sources in `manifest.mjs`.
 *
 * ── WHY EVERY ENTRY CARRIES AN `evidence` STRING ────────────────────────────
 * Each fact records the VERBATIM sentence from the official page that states
 * it. The validator (`validate-seed.mjs`) re-reads the live snapshot and
 * asserts that string is still present. That turns "is our 65% still right?"
 * from a memory exercise into a test:
 *
 *   - Evidence still present  → the fact is still supported. Re-verify the date.
 *   - Evidence gone           → the page changed. Open a manual-review item;
 *                               do NOT silently keep the old number, and do NOT
 *                               silently adopt a new one.
 *
 * This is the mechanism that makes fabrication structurally hard: a number
 * with no matching sentence on an official page cannot pass validation.
 *
 * `extraction_method: 'manual_review'` throughout — a human/agent read the
 * regulator's wording and encoded it. That is deliberately NOT
 * 'automated_parse': a regex over legal prose is exactly how a 33.33% becomes a
 * 3.33%.
 */

export const REGULATORY_RULES = [
  {
    rule_key: 'sama_dbr_bands',
    authority: 'SAMA',
    category: 'debt_burden',
    label_ar: 'نسب الاستقطاع حسب شرائح الدخل',
    label_en: 'Debt-burden ratios by income band',
    description_en:
      'SAMA Responsible Lending Principles for Individual Customers, Chapter IV, Articles 15–17. Three income bands, each with a salary-deduction ceiling (a % of GROSS SALARY), a non-real-estate ceiling and a total-obligations ceiling (both % of TOTAL MONTHLY INCOME).',
    description_ar:
      'مبادئ الإقراض المسؤول لعملاء الأفراد الصادرة عن البنك المركزي السعودي، الفصل الرابع، المواد ١٥–١٧.',
    version: {
      version_number: 1,
      // The Chapter IV instrument's own date: No 465380000099, 17/5/2018 (2/9/1439H).
      effective_from: '2018-05-17',
      effective_to: null,
      source_key: 'sama_rlp_chapter_iv',
      citation_ref: 'SAMA circular 465380000099 dated 2/9/1439H (17/5/2018), Chapter IV Arts. 15–17, as amended by circular 406940000001 dated 09/09/1439H',
      confidence: 'high',
      payload: {
        kind: 'dbr_bands',
        bands: [
          {
            income_from: 0,
            income_to: 15000.01,
            salary_deduction_employee_pct: 33.33,
            salary_deduction_retiree_pct: 25,
            excluding_real_estate_pct: 45,
            total_obligations_pct: 55,
            total_obligations_supported_pct: 65,
            real_estate_per_creditor_policy: false,
          },
          {
            income_from: 15000.01,
            income_to: 25000,
            salary_deduction_employee_pct: 33.33,
            salary_deduction_retiree_pct: 25,
            excluding_real_estate_pct: 45,
            total_obligations_pct: 65,
            total_obligations_supported_pct: 65,
            real_estate_per_creditor_policy: false,
          },
          {
            income_from: 25000,
            income_to: null,
            salary_deduction_employee_pct: 33.33,
            salary_deduction_retiree_pct: 25,
            excluding_real_estate_pct: null,
            total_obligations_pct: null,
            total_obligations_supported_pct: null,
            // Art. 17(b) hands the real-estate decision to the creditor. The
            // engine reports 'requires_bank_review' rather than inventing a %.
            real_estate_per_creditor_policy: true,
          },
        ],
      },
      evidence: [
        'must not exceed 33.33% of the gross salary for employees and 25% for retired consumers',
        'excluding monthly credit obligations for real estate finance, must not exceed 45% of the total monthly income',
        'must not exceed 55% of the total monthly income of the consumer',
        'the monthly obligations of finance must not exceed 65% of the total monthly income',
        'Deductible ratios for consumers whose total monthly income is more than SAR 15,000 and less than SAR 25,000',
        'Credit obligations of finance are subject to the credit policies of the creditor',
      ],
    },
  },

  {
    rule_key: 'sama_qualifying_income',
    authority: 'SAMA',
    category: 'qualifying_income',
    label_ar: 'احتساب إجمالي الدخل الشهري',
    label_en: 'Calculation of total monthly income',
    description_en:
      'Responsible Lending Principles Art. 14: gross salary counts in full; other periodic income counts at HALF its monthly average and must be verifiable via at least a two-year bank statement; government subsidies are excluded EXCEPT documented Ministry of Housing / REDF support in real-estate finance products.',
    description_ar: 'مبادئ الإقراض المسؤول، المادة ١٤.',
    version: {
      version_number: 1,
      effective_from: '2018-05-17',
      effective_to: null,
      source_key: 'sama_rlp_chapter_iv',
      citation_ref: 'SAMA Responsible Lending Principles, Chapter IV, Art. 14 (a)(b)(c), as amended by circular 406940000001',
      confidence: 'high',
      payload: {
        kind: 'qualifying_income',
        gross_salary_pct: 100,
        other_periodic_income_pct: 50,
        other_periodic_income_types: [
          'other_allowance',
          'commission',
          'bonus',
          'rental',
          'investment',
          'business',
          'other_recurring',
          'pension',
        ],
        other_income_min_history_months: 24,
        government_subsidy_excluded: true,
        housing_support_included_in_real_estate: true,
      },
      evidence: [
        'Gross salary, as documented by any means by the employer, must be included in such calculation',
        'half of the monthly average of the total amount earned by the consumer from any periodical income',
        'which can be reasonably verified via, at least, a two-year bank statement',
        'government subsidies that are documented through contracts with a citizen and that are provided by the Ministry of Housing or the Real Estate Development Fund may be incorporated in the total monthly income',
      ],
    },
  },

  {
    rule_key: 'sama_credit_card_obligation',
    authority: 'SAMA',
    category: 'responsible_lending',
    label_ar: 'احتساب التزام البطاقة الائتمانية',
    label_en: 'Credit-card monthly obligation',
    description_en:
      'Responsible Lending Principles Art. 13(a): a credit card’s monthly credit obligation equals the MINIMUM REPAYMENT OF THE CREDIT CEILING for each card issued — a percentage of the LIMIT, not of the outstanding balance and not the customer’s actual payment.',
    description_ar: 'مبادئ الإقراض المسؤول، المادة ١٣(أ).',
    version: {
      version_number: 1,
      effective_from: '2018-05-17',
      effective_to: null,
      source_key: 'sama_rlp_chapter_iv',
      citation_ref: 'SAMA Responsible Lending Principles, Chapter IV, Art. 13(a)',
      confidence: 'high',
      payload: {
        kind: 'credit_card_obligation',
        basis: 'minimum_repayment_of_ceiling',
        // SAMA fixes the BASIS (minimum repayment of the ceiling) but the
        // minimum-repayment percentage itself is set per issuer in the card's
        // own terms. 5% is the prevailing Saudi card minimum; it is recorded
        // here as a REVIEWABLE default with medium confidence, and the seed
        // opens a validation issue naming it, rather than presenting it as a
        // regulator-published figure.
        minimum_repayment_pct: 5,
      },
      evidence: [
        'The monthly credit obligation of a credit card must be equal to the minimum repayment of the credit ceiling for each credit card issued to the consumer',
      ],
      /** Flags a value that needs periodic human confirmation. */
      review_note:
        'SAMA fixes the basis (minimum repayment of the credit ceiling) but not the percentage; 5% is the prevailing issuer minimum and must be confirmed per issuer.',
    },
  },

  {
    rule_key: 'sama_ltv_ceilings',
    authority: 'SAMA',
    category: 'ltv',
    label_ar: 'الحد الأقصى لنسبة التمويل إلى قيمة العقار',
    label_en: 'Maximum loan-to-value ratios',
    description_en:
      'Article 11 of the Implementing Regulation of the Real Estate Finance Law sets a 70% base and permits SAMA to vary it. Circular 371000064087 (6/6/1437H) raised real-estate finance companies (banks excluded) to 85%. Circular 391000048362 (27/4/1439H) raised the FIRST HOME OF CITIZENS ONLY to 90%, leaving banks at 70% and finance companies at 85% for the second home and beyond.',
    description_ar: 'المادة ١١ من اللائحة التنفيذية لنظام التمويل العقاري وتعميما ١٤٣٧ و١٤٣٩.',
    version: {
      version_number: 1,
      effective_from: '2018-01-14',
      effective_to: null,
      source_key: 'sama_ltv_circular_2018',
      citation_ref: 'SAMA circular 391000048362 dated 27/4/1439H (14/1/2018), amending Art. 11 of the Implementing Regulation of the Real Estate Finance Law (Royal Decree M/50 dated 13/8/1433H)',
      confidence: 'high',
      payload: {
        kind: 'ltv',
        bank_first_home_pct: 90,
        bank_additional_home_pct: 70,
        finance_company_first_home_pct: 90,
        finance_company_additional_home_pct: 85,
        first_home_citizens_only: true,
      },
      evidence: [
        'from (85%) to (90%) for the first home of citizens only',
        'Banks will continue to provide real estate financing at (70%) and (85%) for the second home and beyond, respectively, for all beneficiaries',
      ],
    },
  },

  {
    rule_key: 'sama_fee_cap',
    authority: 'SAMA',
    category: 'fees',
    label_ar: 'سقف الرسوم والأتعاب الإدارية',
    label_en: 'Cap on fees and administrative charges',
    description_en:
      'Regulations for Consumer Financing, Art. 9: all fees, costs and administrative services charges recovered from the borrower must not exceed 1% of the amount of financing or SAR 5,000, whichever is LOWER.',
    description_ar: 'لائحة التمويل الاستهلاكي، المادة ٩.',
    version: {
      version_number: 1,
      // The Regulations for Consumer Financing instrument date.
      effective_from: '2014-07-07',
      effective_to: null,
      source_key: 'sama_consumer_financing_regulations',
      citation_ref: 'SAMA Regulations for Consumer Financing, Art. 9 (see also clarification circular 361000091211 dated 30/06/1436H)',
      confidence: 'high',
      payload: {
        kind: 'fee_cap',
        pct_of_finance_amount: 1,
        absolute_cap: 5000,
      },
      evidence: [
        'must not exceed the equivalent of (1%) of the Amount of Financing or (5,000) five thousand Saudi riyals, whichever is lower',
      ],
    },
  },

  {
    rule_key: 'sama_apr_method',
    authority: 'SAMA',
    category: 'apr_methodology',
    label_ar: 'منهجية احتساب معدل النسبة السنوية',
    label_en: 'Annual Percentage Rate calculation methodology',
    description_en:
      'Rules Governing Calculation of the APR (circular 45025707 dated 17/4/1445H, 31/10/2023G), superseding Annex 1 of the Regulations for Consumer Financing. APR is the discount rate equating the present value of amounts received by the borrower with the present value of amounts payable, over dated cash flows, with periods expressed in years on a basis of twelve equal months, including all unavoidable costs and fees but excluding charges arising from the borrower’s own non-compliance.',
    description_ar: 'قواعد احتساب معدل النسبة السنوية، تعميم ٤٥٠٢٥٧٠٧ بتاريخ ١٧/٤/١٤٤٥هـ.',
    version: {
      version_number: 1,
      effective_from: '2023-10-31',
      effective_to: null,
      source_key: 'sama_apr_rules',
      citation_ref: 'SAMA Rules Governing Calculation of the Annual Percentage Rate (APR), circular 45025707 dated 17/4/1445H',
      confidence: 'high',
      payload: {
        kind: 'apr_method',
        method: 'cash_flow_irr',
        day_count: 'twelve_equal_months',
        precision_basis_points: 2,
        include_unavoidable_fees: true,
      },
      evidence: [
        'The discount rate at which the present value of payments and installments that are due from the borrower representing the total amount payable by the borrower equals the present value of all payments of the amount of financing',
        'All the costs to be paid by the borrower under a financing agreement other than the amount of Finance, including term cost, fees, commissions, administrative services fees, insurance',
      ],
    },
  },

  {
    rule_key: 'sama_term_limits',
    authority: 'SAMA',
    category: 'term_limits',
    label_ar: 'الحد الأقصى لمدة التمويل',
    label_en: 'Maximum finance term',
    description_en:
      'Responsible Lending Principles Art. 18: the finance term must not exceed 5 years (60 months), EXCEPT real-estate finance and credit cards — which is why a 30-year mortgage is compliant.',
    description_ar: 'مبادئ الإقراض المسؤول، المادة ١٨.',
    version: {
      version_number: 1,
      effective_from: '2018-05-17',
      effective_to: null,
      source_key: 'sama_rlp_chapter_iv',
      citation_ref: 'SAMA Responsible Lending Principles, Chapter IV, Art. 18',
      confidence: 'high',
      payload: {
        kind: 'term_limits',
        max_term_months: 60,
        exempt_categories: ['residential_purchase', 'off_plan', 'self_build', 'land_and_construction', 'refinance', 'equity_release', 'buy_to_let', 'land_purchase'],
      },
      evidence: ['Finance term must not exceed (5) years or (60) months from granting such finance, except for real estate finance and credit cards'],
    },
  },

  {
    rule_key: 'sama_early_settlement',
    authority: 'SAMA',
    category: 'early_settlement',
    label_ar: 'السداد المبكر',
    label_en: 'Early settlement',
    description_en:
      'Regulations for Consumer Financing, Art. 11: the borrower may prepay without bearing term cost for the remaining period; the creditor may claim reinvestment cost not exceeding the term cost for three months calculated on the declining balance, plus documented unrecoverable third-party expenses.',
    description_ar: 'لائحة التمويل الاستهلاكي، المادة ١١.',
    version: {
      version_number: 1,
      effective_from: '2014-07-07',
      effective_to: null,
      source_key: 'sama_consumer_financing_regulations',
      citation_ref: 'SAMA Regulations for Consumer Financing, Art. 11',
      confidence: 'high',
      payload: {
        kind: 'early_settlement',
        max_reinvestment_months: 3,
        basis: 'declining_balance',
      },
      evidence: ['Article 11'],
    },
  },
];

/**
 * The 2017 first-home circular, seeded as a SUPERSEDED version so a historical
 * calculation dated between Jan 2017 and Jan 2018 replays against the 85%
 * ceiling that was actually in force then. This is the versioning mechanism
 * demonstrating itself on real data rather than a synthetic fixture.
 */
export const SUPERSEDED_RULE_VERSIONS = [
  {
    rule_key: 'sama_ltv_ceilings',
    version_number: 0,
    effective_from: '2017-01-05',
    effective_to: '2018-01-14',
    source_key: 'sama_ltv_circular_2017',
    citation_ref: 'SAMA circular 381000039082 dated 10/4/1438H — first-home LTV raised to 85% (superseded by circular 391000048362)',
    confidence: 'high',
    is_active: true,
    payload: {
      kind: 'ltv',
      bank_first_home_pct: 85,
      bank_additional_home_pct: 70,
      finance_company_first_home_pct: 85,
      finance_company_additional_home_pct: 85,
      first_home_citizens_only: true,
    },
    evidence: ['85'],
  },
];

export const TAX_RULES = [
  {
    tax_key: 'rett',
    authority: 'ZATCA',
    name_ar: 'ضريبة التصرفات العقارية',
    name_en: 'Real Estate Transaction Tax',
    version: {
      version_number: 1,
      effective_from: '2025-04-09',
      effective_to: null,
      rate_pct: 5,
      base: 'higher_of_both',
      payer: 'seller',
      // The State bears the RETT on a citizen's first home up to SAR 1,000,000
      // of the purchase price, administered through Sakani eligibility.
      first_home_relief_cap: 1000000,
      first_home_relief_notes_en:
        'The State bears the 5% RETT on a citizen’s first home up to SAR 1,000,000 of the purchase price, subject to eligibility established through the Sakani programme. Amounts above the cap remain taxable.',
      first_home_relief_notes_ar:
        'تتحمل الدولة ضريبة التصرفات العقارية بنسبة ٥٪ عن المسكن الأول للمواطن حتى مليون ريال من قيمة الشراء وفق أهلية برنامج سكني، وما زاد على ذلك يخضع للضريبة.',
      source_key: 'zatca_rett_guideline',
      citation_ref: 'Real Estate Transaction Tax Law and its Implementing Regulations, effective 9 April 2025; ZATCA detailed RETT guideline',
      // MEDIUM, not high: the ZATCA guideline PDF could not be machine-read in
      // this run (the fetch returned a download stream, recorded as a source
      // failure). The figures come from the reviewed public guideline; the
      // seed opens a validation issue so a human confirms against the PDF.
      confidence: 'medium',
      evidence: [],
      review_note:
        'ZATCA guideline PDF was not machine-readable during collection (download stream). Rate, effective date and the SAR 1,000,000 first-home cap require confirmation against the official PDF before being relied on for a customer quotation.',
    },
  },
];

export const BENCHMARKS = [
  {
    benchmark_key: 'saibor_2y',
    name_ar: 'سايبور لأجل سنتين',
    name_en: 'SAIBOR (average two-year)',
    tenor: '2y',
    administrator: 'Saudi Central Bank (SAMA) / Refinitiv',
    official_url: 'https://rulebook.sama.gov.sa/en/saudi-arabian-benchmark-saiborsaibid',
    observations: [
      {
        // Read from Banque Saudi Fransi's official SAIBOR disclosure page. The
        // page's own fixing date is 11/10/2022 — i.e. THE BANK'S PAGE IS STALE.
        // Seeding it with its real date (rather than today's) is the whole
        // point: the staleness detector then flags it automatically instead of
        // a fresh-looking number silently pricing a variable product.
        observation_date: '2022-10-11',
        rate_pct: 5.92,
        source_key: 'bsf_saibor',
        confidence: 'low',
        evidence: ['AVERAGE TWO YEAR SAIBOR 5.92%', 'FIXING DATE 11/10/2022'],
        review_note:
          'The only machine-readable official SAIBOR disclosure reachable during collection was Banque Saudi Fransi’s page, whose own fixing date is 11/10/2022. SAMA’s statistics endpoints returned server errors. This observation is STALE by design and must not be used to price a live variable product.',
      },
    ],
  },
];

/**
 * Government support programmes.
 *
 * Seeded as ENTITIES ONLY, with `figures_verified: false` and NULL amounts.
 * sakani.sa sat behind a Cloudflare challenge and redf.gov.sa timed out during
 * collection, so no official figure could be read. Every subsidy amount
 * circulating in blog posts was rejected under the source hierarchy. The
 * programme rows exist so a scenario can reference them and so the gap is
 * visible in the admin coverage report — not so a number can be guessed.
 */
export const SUPPORT_PROGRAMS = [
  {
    program_key: 'redf_subsidised_mortgage',
    authority: 'REDF',
    name_ar: 'التمويل العقاري المدعوم — صندوق التنمية العقارية',
    name_en: 'REDF subsidised mortgage',
    program_type: 'subsidised_mortgage',
    official_url: 'https://www.redf.gov.sa/en',
    version: {
      version_number: 1,
      effective_from: '2025-01-01',
      effective_to: null,
      monthly_support_amount: null,
      support_duration_months: null,
      support_cap_amount: null,
      subsidised_principal_cap: null,
      down_payment_grant_amount: null,
      max_property_value: null,
      figures_verified: false,
      source_key: 'redf_home',
      confidence: 'low',
      eligibility_notes_en:
        'Programme exists and is referenced by SAMA’s Responsible Lending Principles Art. 14(c) and Art. 15(c). Its published subsidy figures could NOT be collected: redf.gov.sa timed out and sakani.sa returned a bot challenge during collection. Amounts are intentionally NULL rather than estimated.',
      eligibility_notes_ar:
        'البرنامج قائم ومشار إليه في مبادئ الإقراض المسؤول (المادتان ١٤(ج) و١٥(ج))، ولم يتعذر جمع أرقام الدعم المنشورة رسميًا خلال هذه الدورة.',
      evidence: [],
      review_note:
        'Collect REDF/Sakani subsidy figures from an official source before any support amount is shown to a customer.',
    },
  },
  {
    program_key: 'sakani_housing_support',
    authority: 'Sakani',
    name_ar: 'الدعم السكني — سكني',
    name_en: 'Sakani housing support',
    program_type: 'profit_subsidy',
    official_url: 'https://sakani.sa/app/housing-support',
    version: {
      version_number: 1,
      effective_from: '2025-01-01',
      effective_to: null,
      monthly_support_amount: null,
      support_duration_months: null,
      support_cap_amount: null,
      subsidised_principal_cap: null,
      down_payment_grant_amount: null,
      max_property_value: null,
      figures_verified: false,
      source_key: 'sakani_housing_support',
      confidence: 'low',
      eligibility_notes_en:
        'Sakani is the citizen-facing entry point for housing support and establishes first-home eligibility for the RETT relief. Figures could not be collected: the site returned a bot challenge.',
      eligibility_notes_ar: 'سكني هو البوابة الرسمية للدعم السكني وتحديد أهلية المسكن الأول.',
      evidence: [],
      review_note: 'Collect Sakani support figures from the official platform before relying on them.',
    },
  },
];
