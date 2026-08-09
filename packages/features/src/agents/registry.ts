import type { FeatureDefinition, FeatureId } from '../types';

/**
 * Registry of all supported CLI agent features.
 * Each entry defines how to install, detect, and mount config for the agent.
 *
 * Config paths verified against official docs (Aug 2026).
 */
export const FEATURE_REGISTRY = {
  // ───────────────────────────────────────────────────────────────────────
  // Devin CLI — https://cli.devin.ai
  // ───────────────────────────────────────────────────────────────────────
  devin: {
    id: 'devin',
    name: 'Devin CLI',
    binary: 'devin',
    // The Devin CLI installer is remote and mutable, so there is no default install command.
    // Consumers must either supply a pinned installCommand, set skipInstall for a pre-baked
    // image, or install Devin in the container image at build time.
    installCommand:
      'echo "Devin CLI requires an explicit installCommand or skipInstall=true (pre-baked image)" >&2; exit 1',
    versionCommand: 'devin --version',
    configDirs: [
      { hostPath: '.config/devin', readOnly: true },
      { hostPath: '.local/share/devin', readOnly: false },
    ],
    envVars: ['DEVIN_MODEL', 'DEVIN_PERMISSION_MODE', 'DEVIN_SANDBOX'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Claude Code — https://claude.ai/code
  // ───────────────────────────────────────────────────────────────────────
  claude: {
    id: 'claude',
    name: 'Claude Code CLI',
    binary: 'claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    versionCommand: 'claude --version',
    configDirs: [{ hostPath: '.claude' }],
    envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_MODEL'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // OpenAI Codex CLI — https://chatgpt.com/codex
  // ───────────────────────────────────────────────────────────────────────
  codex: {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    binary: 'codex',
    installCommand: 'npm install -g @openai/codex',
    versionCommand: 'codex --version',
    configDirs: [{ hostPath: '.codex' }],
    envVars: ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Cursor CLI — https://cursor.com
  // ───────────────────────────────────────────────────────────────────────
  cursor: {
    id: 'cursor',
    name: 'Cursor CLI',
    binary: 'cursor',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    versionCommand: 'cursor --version',
    configDirs: [{ hostPath: '.cursor' }],
    envVars: ['CURSOR_CONFIG_DIR'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // OpenCode — https://opencode.ai
  // ───────────────────────────────────────────────────────────────────────
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    binary: 'opencode',
    installCommand: 'curl -fsSL https://opencode.ai/install | bash',
    versionCommand: 'opencode --version',
    configDirs: [
      { hostPath: '.config/opencode', readOnly: true },
      { hostPath: '.local/share/opencode', readOnly: false },
    ],
    envVars: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Kilo Code — https://kilocode.ai
  // ───────────────────────────────────────────────────────────────────────
  kilo: {
    id: 'kilo',
    name: 'Kilo Code',
    binary: 'kilo',
    installCommand: 'npm install -g @kilocode/cli',
    versionCommand: 'kilo --version',
    configDirs: [{ hostPath: '.config/kilo' }],
    envVars: ['KILO_CONFIG', 'KILO_CONFIG_DIR', 'KILO_PROVIDER'],
    acpCompatible: false,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Gemini CLI — https://github.com/google-gemini/gemini-cli
  // ───────────────────────────────────────────────────────────────────────
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    binary: 'gemini',
    installCommand: 'npm install -g @google/gemini-cli',
    versionCommand: 'gemini --version',
    configDirs: [{ hostPath: '.gemini' }],
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
    acpCompatible: false,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Aider — https://aider.chat
  // ───────────────────────────────────────────────────────────────────────
  aider: {
    id: 'aider',
    name: 'Aider',
    binary: 'aider',
    installCommand: 'pip install aider-chat',
    versionCommand: 'aider --version',
    configDirs: [{ hostPath: '.aider' }],
    envVars: ['AIDER_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    acpCompatible: false,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Goose (Block) — https://github.com/block/goose
  // ───────────────────────────────────────────────────────────────────────
  goose: {
    id: 'goose',
    name: 'Goose CLI',
    binary: 'goose',
    installCommand:
      'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
    versionCommand: 'goose --version',
    configDirs: [{ hostPath: '.config/goose' }, { hostPath: '.local/share/goose' }],
    envVars: ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'GOOSE_FAST_MODEL'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Qwen Code — https://github.com/QwenLM/qwen-code
  // ───────────────────────────────────────────────────────────────────────
  qwen: {
    id: 'qwen',
    name: 'Qwen Code',
    binary: 'qwen',
    installCommand: 'npm install -g @qwen-code/qwen-code@latest',
    versionCommand: 'qwen --version',
    configDirs: [{ hostPath: '.qwen' }],
    envVars: ['QWEN_MODEL', 'QWEN_SANDBOX', 'DASHSCOPE_API_KEY'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Amazon Q Developer — https://aws.amazon.com/q/developer
  // ───────────────────────────────────────────────────────────────────────
  'amazon-q': {
    id: 'amazon-q',
    name: 'Amazon Q Developer',
    binary: 'q',
    installCommand:
      'curl --proto \'=https\' --tlsv1.2 -sSf "https://desktop-release.q.us-east-1.amazonaws.com/latest/q-x86_64-linux.zip" -o /tmp/q.zip && unzip -o /tmp/q.zip -d /tmp/q-install && /tmp/q-install/q/install.sh && rm -rf /tmp/q.zip /tmp/q-install',
    versionCommand: 'q --version',
    configDirs: [{ hostPath: '.aws/amazonq' }],
    envVars: ['AWS_PROFILE', 'AWS_REGION', 'Q_LOG_LEVEL'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Cline — https://github.com/cline/cline
  // ───────────────────────────────────────────────────────────────────────
  cline: {
    id: 'cline',
    name: 'Cline',
    binary: 'cline',
    installCommand: 'npm install -g cline',
    versionCommand: 'cline --version',
    configDirs: [{ hostPath: '.cline' }],
    envVars: ['CLINE_DATA_DIR', 'CLINE_SANDBOX', 'CLINE_HOOKS_DIR'],
    acpCompatible: false,
  },

  // ───────────────────────────────────────────────────────────────────────
  // Forge (ForgeCode) — https://forgecode.dev
  // ───────────────────────────────────────────────────────────────────────
  forge: {
    id: 'forge',
    name: 'ForgeCode',
    binary: 'forge',
    installCommand: 'npm install -g @forge-agents/forge',
    versionCommand: 'forge --version',
    configDirs: [{ hostPath: '.forge' }],
    envVars: ['FORGE_API_URL', 'FORGE_WORKSPACE_SERVER_URL'],
    acpCompatible: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // OpenClaw — https://openclaw.ai
  // ───────────────────────────────────────────────────────────────────────
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    binary: 'openclaw',
    installCommand: 'curl -fsSL https://openclaw.ai/install-cli.sh | bash',
    versionCommand: 'openclaw --version',
    configDirs: [{ hostPath: '.openclaw' }],
    envVars: ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_PROFILE'],
    acpCompatible: true,
  },
} as const satisfies Record<FeatureId, FeatureDefinition>;

/** Get a feature definition by id. Throws if not found. */
export function getFeatureDefinition(id: FeatureId): Readonly<FeatureDefinition> {
  const def = FEATURE_REGISTRY[id];
  if (!def) {
    throw new Error(
      `Unknown feature: ${id}. Available: ${Object.keys(FEATURE_REGISTRY).join(', ')}`,
    );
  }
  return def;
}

/** List all available feature ids. */
export function listFeatureIds(): FeatureId[] {
  return Object.keys(FEATURE_REGISTRY) as FeatureId[];
}
