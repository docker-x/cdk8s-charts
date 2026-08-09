/**
 * Example: Hindsight + OmniRoute (ACP with Devin CLI).
 *
 * Deploys a memory stack where:
 *   - OmniRoute proxies LLM calls via Devin CLI (ACP) — no API keys needed
 *   - Hindsight uses OmniRoute as its LLM backend
 *   - Devin CLI shares host OS config for authentication
 *
 * Prerequisites:
 *   - Devin CLI installed and authenticated on the host (config is shared into the pod)
 *   - npx cdk8s synth   (generates K8s manifests in dist/)
 *   - composed add ./dist
 *   - composed up
 */

import { HindsightWithOmniroute } from '@cdk8s-charts/hindsight-omniroute';
import { App, Chart } from 'cdk8s';
import type { Construct } from 'constructs';

class HindsightOmnirouteStack extends Chart {
  public readonly memory: HindsightWithOmniroute;

  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: 'default' });

    this.memory = new HindsightWithOmniroute(this, 'memory', {
      namespace: 'default',
      // OmniRoute with Devin CLI feature — shares host OS config.
      // The default mutable installer is disabled; supply a pinned installCommand or use a pre-baked image.
      omnirouteFeatures: {
        devin: {
          installCommand: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
        },
      },
      // Hindsight config — model is served by OmniRoute via Devin CLI
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
export const stack = new HindsightOmnirouteStack(app, 'hindsight-omniroute');
app.synth();
