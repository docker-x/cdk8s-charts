# @cdk8s-charts/omniroute

Fully typed cdk8s construct for [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — a unified AI proxy/router (one endpoint, 290+ providers, auto-fallback).

OmniRoute is published as an npm package, not a Helm chart, so this construct renders Kubernetes resources directly via ApiObjects (Deployment + Service + PVC).

## Features

- Strongly typed `Props`, `Exports`, and `Values`
- **ACP (Agent Client Protocol)** support — spawn CLI agents (Devin, Claude Code, Codex, etc.) as child processes
- **OS config sharing** — mount host config/credentials into the container so ACP agents authenticate using existing host auth
- Automatic startup script generation (installs omniroute + agents, starts server)
- Deep-merge of computed values with user overrides
- OpenAI-compatible endpoint for downstream consumers

## Usage

### Basic — OmniRoute as an OpenAI-compatible proxy

```typescript
import { App, Chart } from 'cdk8s';
import { Omniroute } from '@cdk8s-charts/omniroute';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'default' });

const omniroute = new Omniroute(chart, 'omniroute', {
  namespace: 'default',
  port: 20128,
});

console.log(omniroute.exports.baseUrl); // 'http://omniroute:20128/v1'
app.synth();
```

### With ACP agents — Devin CLI with shared OS config

```typescript
import { App, Chart } from 'cdk8s';
import { Omniroute } from '@cdk8s-charts/omniroute';

const app = new App();
const chart = new Chart(app, 'my-chart', { namespace: 'default' });

const omniroute = new Omniroute(chart, 'omniroute', {
  namespace: 'default',
  agents: [
    {
      id: 'devin',
      installCommand: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
      shareOsConfig: true, // mounts ~/.config/devin + ~/.local/share/devin
    },
  ],
});

// Wire Hindsight to OmniRoute as its LLM backend
console.log(omniroute.exports.baseUrl); // 'http://omniroute:20128/v1'
app.synth();
```

### With custom OS config paths

```typescript
const omniroute = new Omniroute(chart, 'omniroute', {
  namespace: 'default',
  agents: [
    {
      id: 'claude',
      installCommand: 'npm install -g @anthropic-ai/claude-code',
      shareOsConfig: {
        configPath: '/home/user/.claude',
        extra: {
          '/home/user/.claude.json': '/home/node/.claude.json',
        },
      },
    },
  ],
});
```

## ACP Agents

OmniRoute's ACP (Agent Client Protocol) spawns CLI agents as child processes instead of using HTTP APIs. This gives you "CLI-as-backend" transport — no API keys needed, uses existing CLI authentication.

| Agent ID | Binary | Install |
|----------|--------|---------|
| `devin` | `devin` | `curl -fsSL https://cli.devin.ai/install.sh \| bash` |
| `claude` | `claude` | `npm install -g @anthropic-ai/claude-code` |
| `codex` | `codex` | `npm install -g @openai/codex` |
| `gemini-cli` | `gemini` | `npm install -g @anthropic-ai/gemini-cli` |

When `shareOsConfig` is `true`, the construct mounts:
- `~/.config/<id>` → `/home/node/.config/<id>`
- `~/.local/share/<id>` → `/home/node/.local/share/<id>`

## Exports

| Export | Value | Description |
|--------|-------|-------------|
| `host` | `'{id}'` | Service DNS name |
| `port` | `20128` | OmniRoute server port |
| `baseUrl` | `http://{id}:{port}/v1` | OpenAI-compatible endpoint |
| `dashboardUrl` | `http://{id}:{port}` | Dashboard URL |
