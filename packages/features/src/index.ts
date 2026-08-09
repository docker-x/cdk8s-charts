// Types

// Registry
export { FEATURE_REGISTRY, getFeatureDefinition, listFeatureIds } from './agents/registry';
// FeatureSet resolver
export {
  buildStartupScript,
  getFeatureDefs,
  isAcpCompatible,
  resolveFeatures,
} from './feature-set';
export type {
  ConfigDir,
  DeepPartial,
  FeatureDefinition,
  FeatureId,
  FeatureMap,
  FeatureProps,
  FeatureSetOptions,
  FeatureSetOutput,
  FeatureVolume,
  ShareOsConfig,
} from './types';
