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
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: 'default' });

    new GascityHindsightOmniroute(this, 'stack', {
      namespace: 'default',
      // Gascity — dev environment with Devin
      gascityImageUrl: 'ghcr.io/gascity/gascity:latest',
      gascityDevinShareOsConfig: true,
      // Hindsight — shared memory service
      hindsightApi: {
        llm: {
          model: 'devin-cli-agentic/swe-1-7',
        },
        retain: {
          max_completion_tokens: 16384,
        },
        reranker: {
          local_bucket_batching: true,
        },
      },
    });
  }
}

const app = new App();
new GascityHindsightOmnirouteStack(app, 'gascity-hindsight-omniroute');
app.synth();
