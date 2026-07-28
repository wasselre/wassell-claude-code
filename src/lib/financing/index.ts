/**
 * Public surface of the financing engine.
 *
 * Everything exported here is pure and dependency-free, so the SPA, the Edge
 * API and the unit tests all consume the identical implementation — there is
 * no second copy of the maths anywhere in this repo, and there must not be.
 */
export * from './types';
export { ENGINE_VERSION, runFinancingEngine } from './engine';
export {
  calculateCapacity,
  calculateObligations,
  calculateQualifyingIncome,
  selectDbrBand,
} from './capacity';
export {
  buildSchedule,
  balloonPayment,
  flatProfitPayment,
  flatProfitPrincipalFromPayment,
  monthlyPayment,
  principalFromCapacity,
  principalFromPayment,
  scheduleOutflowTotal,
} from './payment';
export { calculateApr, canCalculateCompliantApr, yearsFromFirstFlow } from './apr';
export {
  applyFeeCap,
  calculateUpfrontCash,
  maxPropertyValue,
  regulatoryLtvCeiling,
  resolveFee,
} from './ltv';
export {
  dataAgeDays,
  evaluateEligibility,
  isPricingStale,
  resolveRate,
} from './matching';
export {
  addMonths,
  ageOn,
  daysBetween,
  fromHalalas,
  minOrNull,
  monthlyRateFromAnnualPct,
  monthsBetween,
  round2,
  roundPct,
  sumOrNull,
  toHalalas,
} from './money';
