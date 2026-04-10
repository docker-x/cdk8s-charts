/**
 * Example: Deploy a memory bank for a coding agent.
 *
 * This sets up Hindsight + LiteLLM so your coding agent can:
 *   - retain() — store facts from coding sessions
 *   - recall() — retrieve relevant knowledge
 *   - reflect() — get synthesized answers from memory
 *
 * Prerequisites:
 *   - cp .env.example .env && fill in values
 *   - set -a && source .env && set +a
 *   - npx cdk8s synth
 */

import { HindsightWithLitellm } from '@cdk8s-charts/hindsight-litellm';
import { App, Chart } from 'cdk8s';
import type { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

class CodingAgentMemory extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: 'coding-agent' });

    new HindsightWithLitellm(this, 'memory', {
      namespace: 'coding-agent',
      masterKey: requireEnv('LITELLM_MASTER_KEY'),
      proxyConfig: {
        model_list: [
          {
            model_name: 'gpt-4o-mini',
            litellm_params: {
              model: 'openai/gpt-4o-mini',
              api_key: 'os.environ/OPENAI_API_KEY',
            },
            model_info: {
              mode: 'chat',
              max_tokens: 16384,
              max_input_tokens: 128000,
              max_output_tokens: 16384,
              supports_function_calling: true,
              supports_vision: true,
            },
          },
          {
            model_name: 'gpt-4o',
            litellm_params: {
              model: 'openai/gpt-4o',
              api_key: 'os.environ/OPENAI_API_KEY',
            },
            model_info: {
              mode: 'chat',
              max_tokens: 16384,
              max_input_tokens: 128000,
              max_output_tokens: 16384,
              supports_function_calling: true,
              supports_vision: true,
            },
          },
          {
            model_name: 'text-embedding-3-small',
            litellm_params: {
              model: 'openai/text-embedding-3-small',
              api_key: 'os.environ/OPENAI_API_KEY',
            },
            model_info: {
              mode: 'embedding',
            },
          },
        ],
        litellm_settings: {
          drop_params: true,
          cache: true,
          cache_params: {
            type: 'redis',
            host: 'os.environ/REDIS_HOST',
            port: 6379,
          },
        },
        general_settings: {
          master_key: 'os.environ/PROXY_MASTER_KEY',
          store_model_in_db: true,
        },
        router_settings: {
          model_group_alias: {
            embedding: 'text-embedding-3-small',
          },
        },
      },
      litellmEnv: {
        OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
      },
      hindsightApi: {
        llm: {
          model: 'gpt-4o-mini',
        },
        retain: {
          llm: { model: 'gpt-4o-mini' },
          max_completion_tokens: 16384,
        },
        reranker: {
          local_bucket_batching: true,
        },
      },
      hindsightLlmKey: requireEnv('HINDSIGHT_LLM_KEY'),
      serviceType: 'LoadBalancer',
    });
  }
}

// ---------------------------------------------------------------------------
// Synth
// ---------------------------------------------------------------------------

const app = new App();
new CodingAgentMemory(app, 'coding-agent-memory');
app.synth();
