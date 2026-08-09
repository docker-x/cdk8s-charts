/**
 * Example: Gascity + Hindsight + OmniRoute — multi-client AI dev stack.
 *
 * Architecture:
 *   Gascity (dev env) → Devin → MCP Hindsight (memory) + LLM Omniroute (gateway)
 *   Hindsight → LLM → Omniroute → Devin (bare, ACP, no plugins)
 *
 * Hindsight + OmniRoute are shared services — not only for Gascity's Devin.
 * Everyone on the PC can use them.
 *
 * Prerequisites:
 *   - npx cdk8s synth   (generates K8s manifests in dist/)
 *   - composed add ./dist  (or use composed.yaml with x-k8s)
 *   - composed up
 */

import { GascityHindsightOmniroute } from '@cdk8s-charts/gascity-hindsight-omniroute';
import { App, Chart } from 'cdk8s';
import type { Construct } from 'constructs';

class GascityHindsightOmnirouteStack extends Chart {
  public readonly stack: GascityHindsightOmniroute;

  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: 'default' });

    this.stack = new GascityHindsightOmniroute(this, 'stack', {
      namespace: 'default',
      // Gascity — dev environment
      gascityImageUrl: 'ghcr.io/gascity/gascity:latest',
      // CLI agent features — composable
      features: {
        devin: true,
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
