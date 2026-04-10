# Skill: add-chart

Add a new typed cdk8s chart (Helm construct) to the monorepo. Use when the user wants to wrap a new Helm chart with TypeScript types.

## Trigger

- User says "add a chart", "add a new chart", "create a construct for X", or "wrap X Helm chart"

## Prerequisites

- Read `DESIGN.md` sections 3 (Construct design) and 5 (Adding a new chart)
- Read `packages/utils/src/helm-construct.ts` to understand the base class
- Read an existing chart (e.g., `packages/charts/litellm/src/`) as a reference

## Workflow

### Step 1: Discover chart values

```bash
helm show values <chart-oci-url>
```

This gives you the raw YAML of every configurable value. You'll type all of these.

### Step 2: Update DESIGN.md first

Before writing any code, add the new chart to DESIGN.md:

1. Add to the package architecture diagram (section 2)
2. Add a new subsection under section 3 with Props, Exports, and resources
3. Update the dependency graph

### Step 3: Create the package structure

```
packages/charts/<name>/
  package.json
  tsconfig.json
  src/
    types.ts
    construct.ts
    index.ts
```

### Step 4: Create package.json

```json
{
  "name": "@cdk8s-charts/<name>",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -b",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@cdk8s-charts/utils": "*",
    "cdk8s": "^2",
    "constructs": "^10"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^22"
  },
  "peerDependencies": {
    "cdk8s": "^2",
    "constructs": "^10"
  }
}
```

### Step 5: Create types.ts

Type every section from `helm show values`:

```typescript
import { DeepPartial, ImageConfig, ResourceRequirements, ... } from '@cdk8s-charts/utils';

// Full Helm chart values
export interface <Name>Values {
  // ... type every section
}

// Construct inputs
export interface <Name>Props {
  namespace: string;
  // Add service-specific props
  values?: DeepPartial<<Name>Values>;
}

// Construct outputs for cross-service wiring
export interface <Name>Exports {
  host: string;
  port: number;
  // Add whatever downstream consumers need
}
```

### Step 6: Create construct.ts

```typescript
import { Construct } from 'constructs';
import { HelmConstruct } from '@cdk8s-charts/utils';
import { <Name>Props, <Name>Exports, <Name>Values } from './types';

export class <Name> extends HelmConstruct<<Name>Values> {
  public readonly exports: <Name>Exports;

  constructor(scope: Construct, id: string, props: <Name>Props) {
    super(scope, id);

    const computed: <Name>Values = { /* ... */ };

    const values = this.renderChart(
      'oci://registry/chart',
      id,
      props.namespace,
      computed,
      props.values,
    );

    this.exports = {
      host: id,
      port: values.service?.port ?? 8080,
    };
  }
}
```

### Step 7: Create index.ts

```typescript
export { <Name> } from './construct';
export type { <Name>Props, <Name>Exports, <Name>Values } from './types';
```

### Step 8: Update tsconfig.base.json

Add path alias:
```json
"@cdk8s-charts/<name>": ["packages/charts/<name>/src/index.ts"]
```

### Step 9: Write a README.md

Include: what the chart does, features, and a usage example.

### Step 10: Verify

```bash
npm install
npm run lint
```

## Patterns to follow

- **Props/Exports**: Every construct MUST have typed Props and Exports. No hardcoded service names or ports outside the construct.
- **Secrets**: Accept as Props, create via `ApiObject` (kind: Secret). Auto-detect with suffix matching if applicable.
- **Env flattening**: Use `this.flattenToEnv(config, 'PREFIX')` for services configured via env vars.
- **Deep merge**: Always use `renderChart()` which handles deep-merge automatically.

## Checklist

- [ ] `helm show values` inspected and all sections typed
- [ ] DESIGN.md updated with new construct spec
- [ ] `src/types.ts` created with Props, Exports, Values
- [ ] `src/construct.ts` created extending HelmConstruct
- [ ] `src/index.ts` exports all public types
- [ ] `tsconfig.base.json` path alias added
- [ ] `README.md` with usage example
- [ ] `npm run lint` passes
