/**
 * Composable CLI agent features — like devcontainer features but without
 * devcontainer syntax. Each feature knows how to install, configure, and
 * mount OS config for a specific AI CLI agent (Devin, Claude Code, Codex, etc).
 *
 * Features are applied to any container (Gascity, Omniroute, custom) via the
 * `FeatureSet` class, which collects enabled features and produces:
 *   - install commands (joined into a startup script)
 *   - hostPath volumes + volumeMounts (for OS config sharing)
 *   - environment variables
 */

export type { DeepPartial } from '@cdk8s-charts/utils';

export type { FeatureId } from './agents/registry';

import type { FeatureId } from './agents/registry';

// ═══════════════════════════════════════════════════════════════════════════
// Feature definitions (static metadata per agent)
// ═══════════════════════════════════════════════════════════════════════════

/** Config directory mount specification. */
export interface ConfigDir {
  /** Host path relative to $HOME (e.g. ".config/devin", ".claude"). */
  hostPath: string;
  /** Container mount path (e.g. "/workspace/.config/devin"). If omitted, uses homeBase + hostPath. */
  containerPath?: string;
}

/** Static metadata for a CLI agent feature. */
export interface FeatureDefinition {
  /** Feature id (e.g. "devin", "claude", "codex"). */
  id: string;
  /** Display name. */
  name: string;
  /** Binary name to detect on PATH (e.g. "devin", "claude", "codex"). */
  binary: string;
  /** Install command (e.g. "npm install -g @anthropic-ai/claude-code"). */
  installCommand: string;
  /** Version check command (e.g. "devin --version"). */
  versionCommand?: string;
  /** Config directories to mount from host. */
  configDirs?: ConfigDir[];
  /** Key environment variables (documentation only — actual values set at runtime). */
  envVars?: string[];
  /** Whether this agent supports ACP (Agent Client Protocol) via Omniroute. */
  acpCompatible?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature props (user-facing configuration)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OS config share options for a feature.
 *
 * When `true`, mounts all default config dirs for the agent.
 * When an object, allows overriding host source paths and adding extra mounts.
 */
export type ShareOsConfig =
  | boolean
  | {
      /** Override host config paths (maps ConfigDir.hostPath -> custom path). */
      paths?: Record<string, string>;
      /** Extra host paths to mount (host -> container). */
      extra?: Record<string, string>;
    };

/** Props for a single enabled feature. */
export interface FeatureProps {
  /** Share host OS config/credentials into the container. Default: true. */
  mountConfig?: ShareOsConfig;
  /** Extra env vars for this agent. */
  env?: Record<string, string>;
  /** Override install command (e.g. pin a version). */
  installCommand?: string;
  /** Skip installation (binary already in image). */
  skipInstall?: boolean;
}

/** Map of feature id -> props. `true` means defaults (mountConfig: true). */
export type FeatureMap = Partial<Record<FeatureId, FeatureProps | true>>;

// ═══════════════════════════════════════════════════════════════════════════
// Feature output (what a feature contributes to a container)
// ═══════════════════════════════════════════════════════════════════════════

/** A hostPath volume + mount produced by a feature. */
export interface FeatureVolume {
  name: string;
  hostPath: string;
  mountPath: string;
}

/** Resolved output from a feature set — ready to inject into a container. */
export interface FeatureSetOutput {
  /** Install commands to run at container startup. */
  installCommands: string[];
  /** hostPath volumes to add to the pod. */
  volumes: FeatureVolume[];
  /** Volume mounts to add to the container. */
  volumeMounts: Array<{ name: string; mountPath: string }>;
  /** Environment variables to set. */
  env: Array<{ name: string; value: string }>;
  /** Feature ids that are enabled. */
  featureIds: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// FeatureSet — collects features and resolves output
// ═══════════════════════════════════════════════════════════════════════════

/** Options for resolving a feature set. */
export interface FeatureSetOptions {
  /** Container home directory (e.g. "/workspace" for Gascity, "/home/node" for Omniroute). */
  homeDir: string;
  /** Feature map — which features to enable and their props. */
  features: FeatureMap;
}
