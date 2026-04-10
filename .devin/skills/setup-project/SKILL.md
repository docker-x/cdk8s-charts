# Skill: setup-project

Set up the cdk8s-charts project for development or try the coding agent memory example. Use when the user wants to get started.

## Trigger

- User says "set up", "install", "get started", "bootstrap", or "try the example"

## Workflow

### Step 1: Check prerequisites

```bash
node --version        # Need v20+
npm --version         # Need v10+
docker --version      # Need Docker running (for Helm OCI pulls)
```

If any are missing, tell the user what to install.

### Step 2: Install dependencies

```bash
cd <project-root>
npm install
```

### Step 3: Verify the build

```bash
npm run lint          # Type-check all packages
```

### Step 4: Try the example

```bash
cd examples/coding-agent-memory
cp .env.example .env
```

Help the user fill in the required values:

| Variable | How to get it |
|----------|---------------|
| `LITELLM_MASTER_KEY` | Generate: `openssl rand -hex 16` |
| `OPENAI_API_KEY` | Get from https://platform.openai.com/api-keys |
| `HINDSIGHT_LLM_KEY` | Generate: `echo "sk-$(openssl rand -hex 16)"` |

### Step 5: Synthesize

```bash
set -a && source .env && set +a
npx cdk8s synth
```

This generates K8s manifests in `dist/`. The user can then apply them to any cluster:

```bash
kubectl apply -f dist/
```

### Step 6: Deploy to local k3d (optional)

If the user wants a local cluster:

```bash
# Create cluster with port mappings
k3d cluster create cdk8s-dev \
  -p "4000:4000@loadbalancer" \
  -p "8888:8888@loadbalancer" \
  -p "3000:3000@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0" \
  --k3s-arg "--disable=metrics-server@server:0"

# Apply
kubectl apply -f dist/

# Wait for pods
kubectl get pods -n coding-agent -w
```

### Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` fails with certificate error | Check `.npmrc` points to public npm registry |
| `cdk8s synth` fails "env var not set" | Run `set -a && source .env && set +a` first |
| Helm chart pull fails | Ensure Docker is running (OCI chart pulls need it) |
| `tsc` errors about missing modules | Run `npm install` from the repo root |
