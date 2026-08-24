import type { Construct } from 'constructs';
import { SolaceBase } from './base';
import type { SolaceProps } from './types';

/**
 * Solace PubSub+ Software Event Broker — single-node non-HA deployment.
 *
 * Wraps the upstream `pubsubplus` Helm chart (prod1k, 30Gi storage by default).
 * Use `PubsubPlusDev` for development or `PubsubPlusHa` for HA redundancy.
 */
export class PubsubPlus extends SolaceBase {
  constructor(scope: Construct, id: string, props: SolaceProps) {
    super(scope, id, props, {
      chartName: 'pubsubplus',
      redundancy: false,
      size: 'prod1k',
      storageSize: '30Gi',
    });
  }
}

/**
 * Solace PubSub+ Software Event Broker — minimum footprint single-node for
 * development. No guaranteed performance.
 *
 * Wraps the upstream `pubsubplus-dev` Helm chart (dev size, 10Gi storage by
 * default).
 */
export class PubsubPlusDev extends SolaceBase {
  constructor(scope: Construct, id: string, props: SolaceProps) {
    super(scope, id, props, {
      chartName: 'pubsubplus-dev',
      redundancy: false,
      size: 'dev',
      storageSize: '10Gi',
    });
  }
}

/**
 * Solace PubSub+ Software Event Broker — HA redundancy group with Primary,
 * Backup, and Monitor nodes.
 *
 * Wraps the upstream `pubsubplus-ha` Helm chart (redundancy=true, prod1k, 30Gi
 * storage by default).
 */
export class PubsubPlusHa extends SolaceBase {
  constructor(scope: Construct, id: string, props: SolaceProps) {
    super(scope, id, props, {
      chartName: 'pubsubplus-ha',
      redundancy: true,
      size: 'prod1k',
      storageSize: '30Gi',
    });
  }
}
