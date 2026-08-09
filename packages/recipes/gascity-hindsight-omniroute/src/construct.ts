/**
 * Backward-compatibility shim for the old Gascity + Hindsight + OmniRoute recipe.
 * Use `@cdk8s-charts/gascity-stack` for new code.
 */

/** @deprecated Use `@cdk8s-charts/gascity-stack` instead. */
/** @deprecated Use `@cdk8s-charts/gascity-stack` instead. */
export type {
  GascityStackExports as GascityHindsightOmnirouteExports,
  GascityStackProps as GascityHindsightOmnirouteProps,
} from '@cdk8s-charts/gascity-stack';
/** @deprecated Use `@cdk8s-charts/gascity-stack` instead. */
export { GascityStack as GascityHindsightOmniroute } from '@cdk8s-charts/gascity-stack';
