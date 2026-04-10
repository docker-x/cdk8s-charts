# Skill: memory-bank

Work with Hindsight memory banks — create, configure, import templates, and query memories. Use when the user wants to manage their coding agent's memory.

## Trigger

- User says "memory bank", "create a bank", "import bank template", "recall", "retain"
- User wants to configure how their agent remembers things

## Concepts

### Facts
When you `retain` content, Hindsight extracts structured **facts** using the bank's retain mission. Facts are classified as world knowledge or experiential events.

### Observations
After facts accumulate, Hindsight **consolidates** them into observations — synthesized patterns from multiple facts.

### Mental models
Named reflect queries that auto-refresh. Pre-computed summaries that cost zero LLM tokens to fetch.

### Directives
Hard rules injected into every reflect/recall prompt (e.g., "never store credentials").

## Bank template format

Templates live in `banks/*.json`:

```json
{
  "version": "1",
  "bank": {
    "retain_mission": "...",
    "retain_extraction_mode": "concise",
    "enable_observations": true,
    "observations_mission": "...",
    "disposition_literalism": 4,
    "disposition_skepticism": 3,
    "disposition_empathy": 4,
    "entity_labels": [ ... ],
    "entities_allow_free_form": true
  },
  "mental_models": [ ... ],
  "directives": [ ... ]
}
```

## API operations

Replace `$BASE` with your Hindsight API URL (e.g., `http://localhost:8888`).
Replace `$BANK` with the bank name (e.g., `coding-agent`).

### Import a bank template

```bash
curl -X POST $BASE/v1/default/banks/$BANK/import \
  -H "Content-Type: application/json" \
  -d @banks/coding-agent.json
```

### Retain a memory

```bash
curl -X POST $BASE/v1/default/banks/$BANK/memories \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "content": "The project uses NX monorepo with cdk8s constructs for typed Helm chart deployment.",
      "document_id": "discovery_monorepo_structure",
      "tags": ["type:context", "domain:infrastructure"]
    }],
    "async": true
  }'
```

### Recall memories

```bash
# Basic recall
curl -X POST $BASE/v1/default/banks/$BANK/memories/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "how to add a new chart", "k": 5}'

# Filter by tags
curl -X POST $BASE/v1/default/banks/$BANK/memories/recall \
  -H "Content-Type: application/json" \
  -d '{
    "query": "deployment issues",
    "tags": ["domain:infrastructure"],
    "tags_match": "all"
  }'
```

### Read a mental model

```bash
curl -s $BASE/v1/default/banks/$BANK/mental-models/project-context
curl -s $BASE/v1/default/banks/$BANK/mental-models/agent-corrections
curl -s $BASE/v1/default/banks/$BANK/mental-models/developer-preferences
```

### Bank stats

```bash
curl -s $BASE/v1/default/banks/$BANK/stats | jq
```

### Trigger consolidation

```bash
curl -X POST $BASE/v1/default/banks/$BANK/consolidate
```

## The coding-agent bank template

Located at `examples/coding-agent-memory/banks/coding-agent.json`. Optimized for AI coding assistants:

### Entity labels

| Label | Tag? | Values |
|-------|------|--------|
| `domain` | no | infrastructure, backend, frontend, tooling, config, debugging |
| `type` | yes | decision, pattern, fix, preference, discovery, correction, lesson |
| `signal` | yes | correction, preference, frustration, instruction, praise |

### Mental models

| ID | Purpose |
|----|---------|
| `project-context` | Tech stack, architecture, conventions |
| `developer-preferences` | Coding style and tool preferences |
| `solved-problems` | Past bugs and fixes |
| `agent-corrections` | What the agent must never repeat |
| `active-work` | Current tasks and open items |

### Directives

| Name | Priority | Rule |
|------|----------|------|
| `no-secrets` | 100 | Never store credentials |
| `prioritize-corrections` | 90 | User corrections carry highest weight |
| `focus-on-reusable` | 50 | Prefer durable knowledge over ephemeral details |
