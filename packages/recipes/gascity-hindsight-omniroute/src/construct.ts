import type { GascityStackExports, GascityStackProps } from '@cdk8s-charts/gascity-stack';

/**
 * Backward-compatibility shim for the old Gascity + Hindsight + OmniRoute recipe.
 * Use `@cdk8s-charts/gascity-stack` for new code.
 */

/** @deprecated Use `@cdk8s-charts/gascity-stack` instead. */
export type GascityHindsightOmnirouteExports = GascityStackExports;

/** @deprecated Use `@cdk8s-charts/gascity-stack` instead. */
export type GascityHindsightOmnirouteProps = GascityStackProps;

/** @deprecated Use `@cdk8s-charts/gascity-stack` instead. */
export { GascityStack as GascityHindsightOmniroute } from '@cdk8s-charts/gascity-stack';
