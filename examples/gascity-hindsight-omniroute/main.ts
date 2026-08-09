/**
 * Example: Gascity + Hindsight + OmniRoute — multi-client AI dev stack.
 *
 * Architecture:
 *   Gascity (dev env) → Devin → MCP Hindsight (memory) + LLM Omniroute (gateway)
 *   Hindsight → LLM → Omniroute → Devin (bare, ACP, no plugins)
 *
 * Hindsight + OmniRoute are shared cluster services by default. Expose them
 * explicitly (e.g. ingress/LoadBalancer) if you want host access.
 *
 * Prerequisites:
 *   - A pullable Gascity image set via GASCITY_IMAGE_URL
 *   - Devin CLI installed and authenticated on the host (config is shared into the pod)
 *   - npx cdk8s synth   (generates K8s manifests in dist/)
 *   - composed add ./dist
 *   - composed up
 */

import { GascityStack } from '@cdk8s-charts/gascity-stack';
import { App, Chart } from 'cdk8s';
import type { Construct } from 'constructs';

const gascityImageUrl = process.env.GASCITY_IMAGE_URL ?? '';
if (!gascityImageUrl) {
  throw new Error('Set GASCITY_IMAGE_URL to a pullable Gascity image before synthesizing.');
}

class GascityHindsightOmnirouteStack extends Chart {
  public readonly stack: GascityStack;

  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: 'default' });

    this.stack = new GascityStack(this, 'stack', {
      namespace: 'default',
      // Gascity — dev environment (set GASCITY_IMAGE_URL to a pullable image)
      gascityImageUrl,
      // CLI agent features — composable.
      // The default mutable Devin installer is disabled; pin or pre-bake in production.
      features: {
        devin: {
          installCommand: 'curl -fsSL https://static.devin.ai/cli/3000.3.27/setup.sh | bash',
        },
      },
      // Hindsight — shared memory service
      hindsight: {
        enabled: true,
        api: {
          llm: {
            model: 'devin-cli-agentic/swe-1-7',
          },
        },
      },
      // OmniRoute — LLM gateway
      omniroute: {
        enabled: true,
      },
    });
  }
}

const app = new App();
export const chart = new GascityHindsightOmnirouteStack(app, 'gascity-hindsight-omniroute');
app.synth();
