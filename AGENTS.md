# Project Rules — cdk8s-charts

## Spec-Driven Development

**DESIGN.md is the single source of truth for all behaviour.**

Before implementing any feature or change:

1. Read `DESIGN.md` to understand the existing spec.
2. If the change alters construct Props/Exports, chart wiring, or architecture: **update DESIGN.md first**, then implement.
3. Code that contradicts DESIGN.md is a bug. DESIGN.md that contradicts desired behaviour needs a spec update before code changes.

## Build & verify

```bash
npm install          # install dependencies
npm run build        # build all packages (NX)
npm run lint         # type-check all packages
```

### Trying the example

```bash
cd examples/coding-agent-memory
cp .env.example .env
# Fill in API keys
set -a && source .env && set +a
npx cdk8s synth      # synthesize K8s manifests to dist/
```

## Code conventions

### TypeScript / cdk8s

- Each chart is a **Construct** extending `HelmConstruct<V>` from `@cdk8s-charts/utils`.
- Every construct has strongly-typed `Props` (inputs) and `Exports` (outputs) — no hardcoded strings.
- Props and Exports types live in `packages/charts/<service>/src/types.ts`.
- Construct logic lives in `packages/charts/<service>/src/construct.ts`.
- Barrel exports from `packages/charts/<service>/src/index.ts`.
- Use `DeepPartial<V>` for optional Helm value overrides.
- Use `deepMerge()` for combining computed values with user overrides (b wins).
- Use `flattenToEnv()` for converting nested config to `UPPER_SNAKE_CASE` env vars.

### Secrets

- **Never commit `.env`** — it's in `.gitignore`.
- **Never hardcode secrets** in TypeScript or config files.
- Use `os.environ/VAR_NAME` in LiteLLM config YAML for runtime secret injection.
- Keys matching `/_API_KEY$|_PASSWORD$|_SECRET$/` are auto-classified as secrets by the Hindsight construct.

### NX monorepo

- All packages live under `packages/` (utils, charts, recipes).
- Examples live under `examples/`.
- Path aliases are defined in `tsconfig.base.json`.
- NX handles dependency ordering, caching, and parallel builds.
- Each package has its own `package.json` and `tsconfig.json`.

## Skills

Detailed step-by-step workflows live in `.agents/skills/`. **Use these instead of improvising.**

| Skill | Trigger | What it does |
|-------|---------|--------------|
| `add-chart` | "add a chart", "wrap X Helm chart" | Full workflow: `helm show values` → type everything → construct → wire → verify |
| `add-recipe` | "compose X and Y", "add a recipe" | Plan wiring → compose chart constructs → create example → verify |
| `setup-project` | "set up", "get started" | Prerequisites → install → build → try the example |
| `memory-bank` | "memory bank", "recall", "retain" | Create/import bank templates, retain/recall API usage, mental models |

### Adding a new chart (summary)

1. Create `packages/charts/<name>/` with `package.json`, `tsconfig.json`, and `src/`.
2. Define `src/types.ts` with `Values`, `Props`, and `Exports` interfaces.
3. Implement `src/construct.ts` extending `HelmConstruct<Values>`.
4. Export from `src/index.ts`.
5. Add workspace entry to root `package.json` if needed.
6. Update `DESIGN.md` with the new construct spec.

Full guide: `.agents/skills/add-chart/SKILL.md`

### Adding a new recipe (summary)

1. Create `packages/recipes/<name>/` with `package.json`, `tsconfig.json`, and `src/`.
2. Import chart constructs from `@cdk8s-charts/<chart>`.
3. Compose them in a single construct with cross-wiring.
4. Export from `src/index.ts`.
5. Update `DESIGN.md`.

Full guide: `.agents/skills/add-recipe/SKILL.md`

## Dependencies

- **npm packages**: cdk8s, constructs (runtime); nx, typescript (dev)
- **Peer dependencies**: cdk8s ^2, constructs ^10
- No additional frameworks beyond these.

## Known gotchas

| Issue | Solution |
|-------|----------|
| `workspace:*` in package.json | Use `*` — npm workspaces don't support `workspace:` protocol |
| Lock files with registry URLs | All lock files are gitignored; `.npmrc` pins public npm registry |
| `cdk8s synth` fails "env var not set" | Run `set -a && source .env && set +a` first |
| `Unsupported parameter: max_tokens` | Use `max_completion_tokens` for reasoning models |
