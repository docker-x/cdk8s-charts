/**
 * Example: Gascity stack — full AI dev environment.
 *
 * Gascity + Hindsight (memory) + OmniRoute (LLM gateway) + CLI agent features.
 *
 * Architecture:
 *   Gascity (dev env) → Devin → MCP Hindsight (memory) + LLM Omniroute (gateway)
 *   Hindsight → LLM → Omniroute → Devin (bare, ACP, no plugins)
 *
 * CLI agent features are composable — enable any combination:
 *   { devin: true, claude: true, codex: true, gemini: true, ... }
 *
 * Subcharts are switchable:
 *   hindsight: { enabled: false }  → no memory service
 *   omniroute: { enabled: false }  → no LLM gateway
 *
 * Prerequisites:
 *   npx cdk8s synth   (generates K8s manifests in dist/)
 *   composed build    (generates docker-compose.yaml)
 */

import { GascityStack } from '@cdk8s-charts/gascity-stack';
import { App, Chart } from 'cdk8s';
import type { Construct } from 'constructs';

class GascityStackExample extends Chart {
  public readonly stack: GascityStack;

  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: 'default' });

    this.stack = new GascityStack(this, 'stack', {
      namespace: 'default',

      // Gascity — dev environment
      gascityImageUrl: 'ghcr.io/gascity/gascity:latest',

      // CLI agent features — composable, any combination
      features: {
        devin: true, // Devin CLI (full-featured in Gascity)
        claude: true, // Claude Code CLI
        codex: true, // OpenAI Codex CLI
        // gemini: true,    // Gemini CLI
        // opencode: true,  // OpenCode
        // cursor: true,    // Cursor CLI
        // aider: true,     // Aider
        // qwen: true,      // Qwen Code
        // goose: true,     // Goose
        // kilo: true,      // Kilo Code
        // 'amazon-q': true, // Amazon Q
        // cline: true,     // Cline
        // forge: true,     // ForgeCode
        // openclaw: true,  // OpenClaw
      },

      // Hindsight — memory service (switchable)
      hindsight: {
        enabled: true,
        api: {
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
      },

      // OmniRoute — LLM gateway (switchable)
      omniroute: {
        enabled: true,
        port: 20128,
      },
    });
  }
}

const app = new App();
export const chart = new GascityStackExample(app, 'gascity-stack');
app.synth();
