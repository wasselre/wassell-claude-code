/**
 * Reviewed provider and product data, extracted from the official provider
 * pages listed in `manifest.mjs` and captured in `data/financing/snapshots/`.
 *
 * SAME EVIDENCE CONTRACT AS THE REGULATORY SEED: every non-null figure carries
 * the verbatim sentence from the provider's own page. `validate-seed.mjs`
 * re-checks each string against the live snapshot, so a bank quietly changing
 * "salary starts from 5,000" to 7,000 surfaces as a failed evidence check and a
 * manual-review row — not as a stale number nobody noticed.
 *
 * ── WHAT THE COLLECTION RUN ACTUALLY FOUND ──────────────────────────────────
 * Saudi banks publish product NAMES, ELIGIBILITY and LIMITS reasonably well,
 * and PRICING almost not at all. Of every product below, three carry a
 * published rate figure and each is a "starting from" or representative-example
 * figure, never a customer-specific contractual rate. That is a property of the
 * market, not a gap in the collection, and the schema models it directly:
 * `rate_disclosure_type` records what kind of figure it is, and products with
 * no published rate get NO rate version at all so the matcher reports
 * 'product_data_unavailable' instead of inventing an installment.
 *
 * `null` means "the provider does not publish this". It never means zero.
 */

export const PROVIDERS = [
  {
    provider_key: 'alrajhi',
    name_ar: 'مصرف الراجحي',
    name_en: 'Al Rajhi Bank',
    short_name_en: 'Al Rajhi',
    provider_type: 'bank',
    website_url: 'https://www.alrajhibank.com.sa',
  },
  {
    provider_key: 'snb',
    name_ar: 'البنك الأهلي السعودي',
    name_en: 'Saudi National Bank',
    short_name_en: 'SNB',
    provider_type: 'bank',
    website_url: 'https://www.alahli.com',
  },
  {
    provider_key: 'riyad',
    name_ar: 'بنك الرياض',
    name_en: 'Riyad Bank',
    short_name_en: 'Riyad Bank',
    provider_type: 'bank',
    website_url: 'https://www.riyadbank.com',
  },
  {
    provider_key: 'alinma',
    name_ar: 'مصرف الإنماء',
    name_en: 'Alinma Bank',
    short_name_en: 'Alinma',
    provider_type: 'bank',
    website_url: 'https://www.alinma.com',
  },
  {
    provider_key: 'albilad',
    name_ar: 'بنك البلاد',
    name_en: 'Bank Albilad',
    short_name_en: 'Albilad',
    provider_type: 'bank',
    website_url: 'https://www.bankalbilad.com',
  },
  {
    provider_key: 'bsf',
    name_ar: 'البنك السعودي الفرنسي',
    name_en: 'Banque Saudi Fransi',
    short_name_en: 'BSF',
    provider_type: 'bank',
    website_url: 'https://bsf.sa',
  },
  {
    provider_key: 'sab',
    name_ar: 'البنك السعودي الأول',
    name_en: 'Saudi Awwal Bank',
    short_name_en: 'SAB',
    provider_type: 'bank',
    website_url: 'https://www.sab.com',
  },
  {
    provider_key: 'anb',
    name_ar: 'البنك العربي الوطني',
    name_en: 'Arab National Bank',
    short_name_en: 'ANB',
    provider_type: 'bank',
    website_url: 'https://anb.com.sa',
  },
  {
    provider_key: 'aljazira',
    name_ar: 'بنك الجزيرة',
    name_en: 'Bank AlJazira',
    short_name_en: 'AlJazira',
    provider_type: 'bank',
    website_url: 'https://www.bankaljazira.com',
  },
  {
    provider_key: 'saib',
    name_ar: 'البنك السعودي للاستثمار',
    name_en: 'The Saudi Investment Bank',
    short_name_en: 'SAIB',
    provider_type: 'bank',
    website_url: 'https://www.saib.com.sa',
  },
  {
    provider_key: 'bidaya',
    name_ar: 'بداية للتمويل العقاري',
    name_en: 'Bidaya Home Finance',
    short_name_en: 'Bidaya',
    provider_type: 'real_estate_finance_company',
    website_url: 'https://www.bidaya.com.sa',
  },
  {
    provider_key: 'dar_altamleek',
    name_ar: 'دار التمليك',
    name_en: 'Dar Al Tamleek',
    short_name_en: 'Dar Al Tamleek',
    provider_type: 'real_estate_finance_company',
    website_url: 'https://www.daraltamleek.com',
  },
  {
    provider_key: 'saudi_home_loans',
    name_ar: 'شركة إس إتش إل للتمويل',
    name_en: 'SHL Finance Company',
    short_name_en: 'SHL',
    provider_type: 'real_estate_finance_company',
    website_url: 'https://www.saudihomeloans.com',
  },
  {
    provider_key: 'amlak',
    name_ar: 'أملاك العالمية',
    name_en: 'Amlak International',
    short_name_en: 'Amlak',
    provider_type: 'real_estate_finance_company',
    website_url: 'https://www.amlak.com.sa',
  },
  {
    provider_key: 'deutsche_gulf',
    name_ar: 'دويتشه للتمويل العقاري',
    name_en: 'Deutsche Gulf Finance',
    short_name_en: 'DGF',
    provider_type: 'real_estate_finance_company',
    website_url: 'https://www.dgf.com.sa',
  },
];

/**
 * NOTE ON `license_verified`: every provider above is seeded with
 * license_verified = false. SAMA's licensed-entity register
 * (sama.gov.sa/en-US/Finance/pages/financinglicencedentities.aspx) returned a
 * server error page on every attempt during collection, so the register could
 * not be read. Rather than assert "SAMA-licensed" on our own authority, the
 * flag stays false, the fetch failure is recorded, and the admin coverage
 * report shows the gap.
 */

export const PRODUCTS = [
  // ── Al Rajhi Bank ────────────────────────────────────────────────────────
  {
    provider_key: 'alrajhi',
    product_key: 'home_finance',
    name_ar: 'التمويل العقاري السكني',
    name_en: 'Home Finance',
    category: 'residential_purchase',
    structure: 'murabaha',
    source_key: 'alrajhi_home_finance',
    official_url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Home-Finance',
    version: {
      effective_from: '2026-07-28',
      applies_to_saudi: true,
      applies_to_resident: true,
      property_status: ['completed'],
      requires_approved_employer: false,
      requires_salary_transfer: false,
      min_salary: 7000,
      min_salary_no_transfer: 10000,
      min_employment_months: 3,
      min_age_years: 18,
      max_age_at_maturity: 70,
      max_amount: 5000000,
      max_term_months: 360,
      grace_period_months: 3,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      required_documents: [
        'Salary transfer statement from employer',
        'Copy of building permits',
        'Copy of owner ID',
        'Copy of the title deed',
        'Monthly expense declaration form',
        'Valid ID',
        'Salary certificate from employer',
        'Sketch of property location',
      ],
      conditions_notes:
        'Murabaha financing for a property from Ministry of Housing projects or a ready-made market unit. Available to REDF and non-REDF customers. The bank publishes a "competitive and fixed profit margin" but no rate figure.',
      evidence: [
        'Financing period up to 30 years',
        'Financing amount up to  5 Million',
        'Grace Period up to 3 Months',
        'Financing up to the age of 70',
        'Minimum age of 18',
        'Minimum service 3 months',
        'Saudis and Residents (Expats)',
      ],
      // No rate version: the page states a "Competitive and fixed profit
      // margin" without a number. The matcher will therefore report
      // 'product_data_unavailable' rather than price it.
      rate: null,
    },
  },
  {
    provider_key: 'alrajhi',
    product_key: 'off_plan',
    name_ar: 'البيع على الخارطة',
    name_en: 'Off-Plan',
    category: 'off_plan',
    structure: 'murabaha',
    source_key: 'alrajhi_off_plan',
    official_url: 'https://alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/off-plan',
    version: {
      effective_from: '2026-07-28',
      applies_to_saudi: true,
      // "non-Saudi customers who hold a premium residency" — a narrower
      // eligibility than ordinary residency, captured in conditions_notes
      // because the schema has no premium-residency flag.
      applies_to_resident: true,
      property_status: ['off_plan'],
      requires_salary_transfer: false,
      min_salary: 5000,
      min_salary_no_transfer: 7000,
      min_employment_months: 3,
      max_term_months: 360,
      max_amount: 5000000,
      retiree_eligible: true,
      calculation_method: 'off_plan_staged',
      supports_step_up: true,
      early_settlement_terms: 'Early settlement is available at any time upon the customer’s request.',
      confidence: 'medium',
      required_documents: [
        'A statement of salary transfer from employer (if financed with salary transfer)',
        'Declaration form',
        'Monthly expense declaration form',
        'Valid national ID or premium residency ID',
        'Price quotation for the unit from an Al Rajhi-approved project',
        'Salary certificate from employer',
      ],
      conditions_notes:
        'Developer builds the unit within a maximum of 36 months. Residency eligibility is limited to holders of PREMIUM residency, not ordinary iqama. The bank states the ability to raise the DBR to enable financing up to 75%; flexible repayment from SAR 400/month for the first 3 years; down payment may be financed interest-free over 3 years.',
      evidence: [
        'within a maximum period of 36 months',
        'Ability to obtain financing with tenure up to 360 months',
        'Salary starts from  5,000 for salary transfer and 7,000 for non-salary transfer',
        'Minimum service 3 months',
        'Finance amount is up to  5 m',
        'Early Settlement is available at any time upon customer',
        'The possibility of financing non-Saudi customers who hold a premium residency',
      ],
      rate: {
        effective_from: '2026-07-28',
        rate_type: 'fixed',
        // "APR starts from 5.96%" — a FLOOR, not this customer's rate, and an
        // APR rather than a contractual profit rate. Both facts are recorded so
        // the engine prices it with rate_basis='starting_from' at LOW
        // confidence and labels it in the UI.
        rate_disclosure_type: 'starting_from',
        contractual_rate_pct: null,
        published_apr_pct: 5.96,
        applicability_notes:
          'Published as "APR starts from 5.96%" — a published floor, not a customer-specific rate. No contractual profit rate is published, so any installment derived from it is an approximation and requires a bank quotation to confirm.',
        confidence: 'low',
        evidence: ['APR starts from 5.96%'],
      },
    },
  },
  {
    provider_key: 'alrajhi',
    product_key: 'flexible_finance',
    name_ar: 'التمويل المرن',
    name_en: 'Flexible Finance Product',
    category: 'residential_purchase',
    structure: 'murabaha',
    source_key: 'alrajhi_flexible',
    official_url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Flexible-Finance-Product',
    version: {
      effective_from: '2026-07-28',
      applies_to_saudi: true,
      applies_to_resident: true,
      supported_financing: false,
      unsupported_financing: true,
      min_salary: 5000,
      max_amount: 5000000,
      calculation_method: 'step_up',
      supports_step_up: true,
      confidence: 'medium',
      conditions_notes:
        'For NON-REDF customers only. Offered with National Housing Company. Installment starting from SAR 400 during a 36-month construction period.',
      evidence: [
        'Financing Amount up to  5 Million',
        'Salary starts from  5,000',
        'For Non-REDF Customers',
        'Accepting all customers, whether Saudi or Resident',
        'Installment starting from 400  during the construction period for 36 months',
      ],
      rate: {
        effective_from: '2026-07-28',
        rate_type: 'fixed',
        // A CONTRACTUAL rate floor this time, not an APR floor — the
        // distinction the disclosure-type column exists to preserve.
        rate_disclosure_type: 'starting_from',
        contractual_rate_pct: 7.75,
        published_apr_pct: null,
        applicability_notes:
          'Published as "Annual Profit Rate starts from 7.75%" — a contractual-rate FLOOR. The customer’s actual rate may be higher, and the APR (which includes fees) will exceed it.',
        confidence: 'low',
        evidence: ['Annual Profit Rate starts from 7.75%'],
      },
    },
  },
  {
    provider_key: 'alrajhi',
    product_key: 'property_power',
    name_ar: 'قوة العقار',
    name_en: 'Property Power',
    category: 'equity_release',
    structure: 'murabaha',
    source_key: 'alrajhi_property_power',
    official_url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Property-Power',
    version: {
      effective_from: '2026-07-28',
      // "Saudi nationality only" — an explicit exclusion, so applies_to_resident
      // is FALSE rather than null. This is a genuine published criterion.
      applies_to_saudi: true,
      applies_to_resident: false,
      requires_approved_employer: false,
      requires_salary_transfer: false,
      min_salary: 7000,
      min_salary_no_transfer: 10000,
      min_employment_months: 3,
      min_age_years: 18,
      max_age_at_maturity: 70,
      max_amount: 5000000,
      max_term_months: 360,
      grace_period_months: 3,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      conditions_notes:
        'Secured financing against the value of an owned home. Available to REDF and bank customers. Co-borrower concept available for non-REDF customers only.',
      evidence: [
        'Financing period up to 30 years',
        'Financing amount up to  5 Million',
        'Saudi nationality only',
        'Minimum age of 18',
        'Minimum service 3 months',
        'Salary starts from 7,000 for salary transfer and 10,000 for non-salary transfer',
        'Grace Period up to 3 Months',
      ],
      rate: null,
    },
  },
  {
    provider_key: 'alrajhi',
    product_key: 'buyout',
    name_ar: 'شراء المديونية العقارية',
    name_en: 'Buyout Home Finance',
    category: 'refinance',
    structure: 'murabaha',
    source_key: 'alrajhi_buyout',
    official_url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Buyout-Home-Finance',
    version: {
      effective_from: '2026-07-28',
      applies_to_saudi: true,
      applies_to_resident: false,
      property_status: ['refinance'],
      min_salary: 7000,
      min_salary_no_transfer: 10000,
      min_employment_months: 3,
      min_age_years: 18,
      max_age_at_maturity: 70,
      max_amount: 5000000,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      conditions_notes:
        'Transfers an existing mortgage from another bank, continuing REDF support for supported customers. Requires a No Objection Certificate from the current financier. First two installments may be deferred.',
      evidence: [
        'Financing amount up to  5 Million',
        'Saudi nationality only',
        'Minimum age of 18',
        'No Objection Certificate from another bank/financial institution',
        'Salary starts from 7,000 for salary transfer and 10,000 for non-salary transfer',
      ],
      rate: null,
    },
  },
  {
    provider_key: 'alrajhi',
    product_key: 'tharwa_buy_to_let',
    name_ar: 'ثروة — التمويل بالدخل الإيجاري',
    name_en: 'Tharwa Buy-to-Let',
    category: 'buy_to_let',
    structure: 'murabaha',
    source_key: 'alrajhi_tharwa',
    official_url: 'https://www.alrajhibank.com.sa/en/Personal/Finance/Real-Estate-Finance/Tharwa',
    version: {
      effective_from: '2026-07-28',
      max_age_at_maturity: 70,
      max_amount: 25000000,
      max_term_months: 240,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      required_documents: [
        'Valid national ID / Iqama',
        'Property title deed',
        'Ejar contracts',
        'Proof of rental income (bank statement or Ejar receipt)',
        'Valid building permit',
      ],
      conditions_notes:
        'Repayment is based on RENTAL INCOME rather than salary, for residential or commercial income-generating property with a proven rental stream. Because capacity here derives from rent, not salary, a salary-based affordability result does not describe this product.',
      evidence: [
        'Tenure up to 20 years',
        'Financing up to  25 million',
        'Eligibility up to age 70',
        'without requiring salary-based commitments',
      ],
      rate: null,
    },
  },

  // ── Bank Albilad ─────────────────────────────────────────────────────────
  {
    provider_key: 'albilad',
    product_key: 'off_plan',
    name_ar: 'التمويل على الخارطة',
    name_en: 'Off Plan Financing',
    category: 'off_plan',
    structure: null,
    source_key: 'albilad_real_estate',
    official_url: 'https://www.bankalbilad.com/en/personal/financing/real-estate',
    version: {
      effective_from: '2026-07-28',
      property_status: ['off_plan'],
      max_amount: 3000000,
      calculation_method: 'off_plan_staged',
      confidence: 'medium',
      conditions_notes: 'Offered within Albilad’s financing programmes in cooperation with Eskan and REDF.',
      evidence: ['Off-plan financing by Bank Albilad offers a financing amount up to SAR 3,000,000'],
      rate: null,
    },
  },
  {
    provider_key: 'albilad',
    product_key: 'subsidised_home',
    name_ar: 'التمويل العقاري المدعوم',
    name_en: 'Subsidized Home Financing',
    category: 'residential_purchase',
    structure: null,
    source_key: 'albilad_real_estate',
    official_url: 'https://www.bankalbilad.com/en/personal/financing/real-estate',
    version: {
      effective_from: '2026-07-28',
      supported_financing: true,
      unsupported_financing: false,
      // A published salary CEILING, not a floor — this product is for lower
      // incomes. Encoded as a hard eligibility rule rather than min_salary,
      // which would invert its meaning.
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      conditions_notes:
        'For customers with a monthly salary of SAR 14,000 or less, who receive a 0% profit margin on the subsidised portion. Note this is a salary CEILING for eligibility, not a minimum.',
      eligibility_rules: [
        {
          rule_key: 'max_salary_14000',
          label_en: 'Monthly salary must be SAR 14,000 or less',
          label_ar: 'الراتب الشهري ١٤٬٠٠٠ ريال أو أقل',
          operator: 'lte',
          field_path: 'income.primary_gross_salary',
          value_numeric: 14000,
          is_hard_requirement: true,
          failure_message_en: 'This subsidised product is limited to customers earning SAR 14,000 per month or less',
          failure_message_ar: 'هذا المنتج المدعوم مخصص لمن دخلهم الشهري ١٤٬٠٠٠ ريال أو أقل',
        },
      ],
      evidence: ['customers with monthly salary 14,000 SAR or lesser can avail 0% profit margin on subsidized loan'],
      rate: {
        effective_from: '2026-07-28',
        rate_type: 'fixed',
        // 0% is a REAL published rate here, which is exactly why the payment
        // maths carries an explicit zero-rate branch instead of dividing by
        // zero in the annuity formula.
        rate_disclosure_type: 'exact_rate',
        contractual_rate_pct: 0,
        published_apr_pct: null,
        applicability_notes:
          '0% profit margin applies to the SUBSIDISED portion for eligible customers earning SAR 14,000/month or less. Any unsubsidised portion is priced separately and is not published.',
        confidence: 'medium',
        evidence: ['0% profit margin on subsidized loan'],
      },
    },
  },
  {
    provider_key: 'albilad',
    product_key: 'military_decreasing',
    name_ar: 'التمويل العقاري المرن للعسكريين',
    name_en: 'Decreasing flexible mortgage for military personnel',
    category: 'residential_purchase',
    structure: null,
    source_key: 'albilad_real_estate',
    official_url: 'https://www.bankalbilad.com/en/personal/financing/real-estate',
    version: {
      effective_from: '2026-07-28',
      employment_types: ['military'],
      max_age_at_maturity: 70,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      conditions_notes:
        'Military real-estate financing runs to age 70 rather than terminating at the retirement date implied by military rank — which is the constraint that usually shortens a serving officer’s term.',
      evidence: ['Military real estate financing until the age of 70'],
      rate: null,
    },
  },
  {
    provider_key: 'albilad',
    product_key: 'self_building',
    name_ar: 'تمويل البناء الذاتي',
    name_en: 'Self Building Financing',
    category: 'self_build',
    structure: null,
    source_key: 'albilad_real_estate',
    official_url: 'https://www.bankalbilad.com/en/personal/financing/real-estate',
    version: {
      effective_from: '2026-07-28',
      property_status: ['self_build'],
      calculation_method: 'staged_construction',
      confidence: 'medium',
      conditions_notes: 'Disbursed as 4 financing payments distributed across the construction stages.',
      evidence: ['4 financing payments distributed throughout the construction stages'],
      rate: null,
    },
  },
  {
    provider_key: 'albilad',
    product_key: 'residents',
    name_ar: 'التمويل العقاري للمقيمين',
    name_en: 'Real Estate Financing for Residents',
    category: 'residential_purchase',
    structure: null,
    source_key: 'albilad_real_estate',
    official_url: 'https://www.bankalbilad.com/en/personal/financing/real-estate',
    version: {
      effective_from: '2026-07-28',
      applies_to_saudi: false,
      applies_to_resident: true,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      conditions_notes: 'Real-estate financing solution offered specifically to expatriate residents.',
      evidence: ['Bank Albilad offers real estate financing for expatriates'],
      rate: null,
    },
  },

  // ── Saudi Awwal Bank ─────────────────────────────────────────────────────
  {
    provider_key: 'sab',
    product_key: 'home_equity_redf_subsidised',
    name_ar: 'تمويل عقاري مدعوم من صندوق التنمية العقارية',
    name_en: 'Home Equity Subsidized by REDF',
    category: 'residential_purchase',
    structure: 'tawarruq',
    source_key: 'sab_subsidised',
    official_url:
      'https://www.sab.com/en/personal/finance/home-finance-products/ministry-products/government-subsides-product/subsidized-mortgage/',
    version: {
      effective_from: '2026-07-28',
      supported_financing: true,
      max_ltv_pct: 90,
      min_down_payment_pct: 10,
      calculation_method: 'fixed_amortizing',
      early_settlement_terms: 'Early payment fees: profits for the next three months.',
      confidence: 'high',
      conditions_notes:
        'Tawarruq-based, with profits subsidised for up to SAR 500,000 by REDF and the Ministry of Housing. The land or property is mortgaged as security until full repayment.',
      evidence: [
        'subsidized profits for up to 500,000',
        'Profits for the next three months',
      ],
      rate: {
        effective_from: '2026-07-28',
        rate_type: 'fixed',
        // A genuine REPRESENTATIVE EXAMPLE with all its assumptions published —
        // the most complete pricing disclosure the whole collection run found.
        // Stored WITH its assumptions so the UI can state them rather than
        // implying the 6.78% applies to any customer.
        rate_disclosure_type: 'representative_example',
        contractual_rate_pct: null,
        published_apr_pct: 6.78,
        example_property_price: 500000,
        example_term_months: 300,
        example_ltv_pct: 90,
        example_monthly_payment: 3030.0,
        rate_assumptions:
          'Published example: property value SAR 500,000, max financing 90%, 25-year term, fixed profit margin, monthly installment SAR 3,030.00, APR 6.78%.',
        applicability_notes:
          'The bank states: "The annual percentage rate and the monthly installment may change based on the value of the financing, the financing period, and the profit margin currently approved by the bank." Rates presented are examples and may vary.',
        confidence: 'medium',
        evidence: ['6.78%', '3,030.00', '25 Years', '500,000'],
      },
    },
  },

  // ── Dar Al Tamleek ───────────────────────────────────────────────────────
  {
    provider_key: 'dar_altamleek',
    product_key: 'home_finance_murabaha',
    name_ar: 'التمويل العقاري بالمرابحة',
    name_en: 'Home Finance Murabaha',
    category: 'residential_purchase',
    structure: 'murabaha',
    source_key: 'dar_altamleek_products',
    official_url: 'https://www.daraltamleek.com/en/',
    version: {
      effective_from: '2026-07-28',
      applies_to_first_home: true,
      supported_financing: true,
      // A finance company, so SAMA's 85%/90% cells apply rather than a bank's
      // 70% — the provider_type is what selects the right ceiling.
      min_down_payment_pct: 5,
      max_ltv_pct: 95,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      conditions_notes:
        'Murabaha-based home finance under the REDF / Ministry of Housing housing-support programme, with a down-payment reduction service reaching as low as 5% for first-home buyers. NOTE: a 5% down payment implies 95% LTV, which exceeds the 90% first-home regulatory ceiling; the engine applies the lower of the two, and this discrepancy is raised as a validation issue for human confirmation.',
      evidence: [
        'Down Payment Reduction Service – as low as 5% for First Homebuyers',
        'Murabaha-based home finance program',
      ],
      rate: null,
    },
  },

  // ── SHL Finance Company ──────────────────────────────────────────────────
  {
    provider_key: 'saudi_home_loans',
    product_key: 'retail_financing',
    name_ar: 'التمويل العقاري للأفراد',
    name_en: 'Retail Financing',
    category: 'residential_purchase',
    structure: null,
    source_key: 'shl_products',
    official_url: 'https://www.saudihomeloans.com/en/',
    version: {
      effective_from: '2026-07-28',
      requires_salary_transfer: false,
      calculation_method: 'fixed_amortizing',
      confidence: 'medium',
      conditions_notes:
        'Sharia-compliant retail real-estate financing. The company explicitly advertises that no salary transfer is required — a meaningful differentiator for customers unwilling to move their salary.',
      evidence: ['No Salary Transfer Required'],
      rate: null,
    },
  },

  // ── Alinma Bank ──────────────────────────────────────────────────────────
  // Alinma publishes SEVEN named real-estate products but no eligibility or
  // pricing figures, and states outright that its displayed ratios are examples
  // subject to its credit policy. They are seeded as product entities with a
  // 1–30 year term envelope (the only published figure) and no rate version, so
  // they appear in the comparison marked 'product_data_unavailable' rather than
  // being invisible to a rep who needs to know the product exists.
  ...['self_build', 'refinance', 'ready_unit', 'land_and_construction', 'land_and_loan', 'off_plan', 'equity_release'].map(
    (key, index) => ({
      provider_key: 'alinma',
      product_key: key,
      name_ar: [
        'منتج البناء الذاتي',
        'منتج إعادة التمويل العقاري',
        'شراء وحدة جاهزة',
        'أرض وبناء',
        'منتج أرض وقرض',
        'شراء وحدة تحت الإنشاء (البيع على الخارطة)',
        'تمويل بضمان رهن العقار',
      ][index],
      name_en: [
        'Self-Construction Financing',
        'Real Estate Re-Finance',
        'Ready Unit Purchase',
        'Land and Construction',
        'Land and Loan',
        'Off-Plan Purchase',
        'Equity Release Finance',
      ][index],
      category: [
        'self_build',
        'refinance',
        'residential_purchase',
        'land_and_construction',
        'land_purchase',
        'off_plan',
        'equity_release',
      ][index],
      structure: null,
      source_key: 'alinma_real_estate',
      official_url: 'https://www.alinma.com/Retail/Financing/alinma-Real-Estate-Financing',
      version: {
        effective_from: '2026-07-28',
        min_term_months: 12,
        max_term_months: 360,
        calculation_method: 'unknown',
        confidence: 'low',
        conditions_notes:
          'Alinma publishes the product name and a 1–30 year calculator range but no eligibility, limits or pricing. The bank states: "Information and ratios mentioned are examples only; prices and approval subject to Alinma’s credit policies."',
        evidence: ['التمويل العقاري'],
        rate: null,
      },
    }),
  ),
];

/**
 * Products the collection run could NOT reach. Recorded so the coverage report
 * distinguishes "this provider has no residential product" from "we could not
 * read the page" — a distinction that decides whether a rep should phone the
 * bank.
 */
export const UNREACHABLE_PROVIDERS = [
  { provider_key: 'riyad', source_key: 'riyad_real_estate', reason: 'not_found', note: 'Riyad Bank real-estate finance URLs returned 404 during collection; the correct product path must be rediscovered.' },
  { provider_key: 'bsf', source_key: 'bsf_real_estate', reason: 'access_denied', note: 'bsf.sa returned "You do not have permissions to access this page" for the real-estate finance path.' },
  { provider_key: 'anb', source_key: 'anb_real_estate', reason: 'empty_body', note: 'Arab National Bank site was under maintenance during collection.' },
  { provider_key: 'saib', source_key: 'saib_real_estate', reason: 'not_found', note: 'The Saudi Investment Bank real-estate finance path returned 404.' },
  { provider_key: 'aljazira', source_key: 'aljazira_real_estate', reason: 'no_product_detail', note: 'Bank AlJazira’s page rendered the personal-banking landing content only; the real-estate detail page must be rediscovered.' },
  { provider_key: 'bidaya', source_key: 'bidaya_products', reason: 'no_product_detail', note: 'Bidaya’s products page rendered only "Retail Financing — Mortgage Finance" with no detail.' },
  { provider_key: 'amlak', source_key: 'amlak_products', reason: 'not_found', note: 'Amlak International individuals path returned 404.' },
  { provider_key: 'deutsche_gulf', source_key: 'dgf_products', reason: 'fetch_failed', note: 'dgf.com.sa was unreachable (tunnel connection failed) during collection.' },
  { provider_key: 'snb', source_key: 'snb_pricing', reason: 'no_residential_pricing', note: 'SNB’s "Finance & Saving Pricing" page publishes LEASE finance pricing only; residential pricing is not published there.' },
];
