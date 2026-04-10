# Skill: add-recipe

Add a new recipe that composes multiple charts into a single stack with automatic cross-wiring. Use when the user wants to create a pre-configured combination of services.

## Trigger

- User says "add a recipe", "compose X and Y", "create a stack for X + Y"

## Prerequisites

- Read `DESIGN.md` sections 3.4 (recipes) and 6 (Adding a new recipe)
- Read `packages/recipes/hindsight-litellm/src/construct.ts` as a reference

## Workflow

### Step 1: Plan the wiring

Before coding, document:
1. Which charts are composed?
2. What connects to what? (service URLs, keys, MCP endpoints)
3. What does the user need to configure vs. what is auto-wired?

### Step 2: Update DESIGN.md

Add the recipe to:
1. Package architecture (section 2)
2. Construct design (new subsection under section 3)
3. Dependency graph

### Step 3: Create the package

```
packages/recipes/<name>/
  package.json        # depends on chart packages
  tsconfig.json       # references chart tsconfigs
  src/
    construct.ts      # composed construct
    index.ts          # barrel exports
  README.md
```

### Step 4: Implement the construct

Key patterns:
- Import chart constructs from their packages
- Accept a simplified Props that hides wiring details
- Auto-wire service URLs using chart exports (host, port)
- Auto-provision authentication (virtual keys, tokens)
- Expose combined Exports

```typescript
import { Construct } from 'constructs';
import { ChartA } from '@cdk8s-charts/chart-a';
import { ChartB } from '@cdk8s-charts/chart-b';

export class ChartAWithChartB extends Construct {
  public readonly exports: { a: ChartAExports; b: ChartBExports };

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const a = new ChartA(this, 'chart-a', { /* ... */ });

    const b = new ChartB(this, 'chart-b', {
      // Auto-wire using exports from chart A
      someUrl: `http://${a.exports.host}:${a.exports.port}/v1`,
    });

    this.exports = { a: a.exports, b: b.exports };
  }
}
```

### Step 5: Create an example

Add `examples/<use-case>/` with:
- `main.ts` showing real-world usage
- `.env.example` with required variables
- Any config templates (bank configs, etc.)

### Step 6: Verify

```bash
npm install
npm run lint
```

## Checklist

- [ ] DESIGN.md updated with recipe spec
- [ ] `src/construct.ts` composes charts with auto-wiring
- [ ] `src/index.ts` exports construct and types
- [ ] `tsconfig.base.json` path alias added
- [ ] `README.md` with usage example
- [ ] Example created in `examples/`
- [ ] `npm run lint` passes
