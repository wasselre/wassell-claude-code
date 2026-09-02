/**
 * Asset meta — barrel for the deterministic meta pass + rights classification
 * (Post Creative Director, owner A-ASSETS).
 */

export {
  applyDeterministicMeta,
  computeDeterministicMeta,
  dominantColorsFromPixels,
  readImageSize,
  snapAspectRatio,
  type DeterministicMeta,
  type DominantColor,
  type FilesWriteClient,
} from './deterministic.js';

export {
  classifyRights,
  recheckRightsForFinal,
  type AcquisitionSourceValue,
  type AssetNatureValue,
  type RightsBadge,
  type RightsClassification,
  type RightsReadClient,
  type RightsRecheckItem,
  type RightsRecheckResult,
  type RightsRow,
  type UsageRightsValue,
} from './rights.js';
