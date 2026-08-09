import { join, posix } from 'node:path';
import { getFeatureDefinition } from './agents/registry';
import type {
  FeatureDefinition,
  FeatureId,
  FeatureMap,
  FeatureProps,
  FeatureSetOptions,
  FeatureSetOutput,
  FeatureVolume,
  ShareOsConfig,
} from './types';

/** Pinned Devin CLI installer that fetches a versioned manifest and verifies the binary SHA-256. */
export const DEFAULT_DEVIN_INSTALL_COMMAND =
  'curl -fsSL https://static.devin.ai/cli/3000.3.27/setup.sh | bash';

/**
 * Ensure the Devin feature has an explicit pinned installer when neither a custom
 * installCommand nor skipInstall is provided. This prevents the registry guard
 * from crash-looping the container.
 */
export function normalizeDevinInstall(features: FeatureMap): FeatureMap {
  if (features.devin === true) {
    return { ...features, devin: { installCommand: DEFAULT_DEVIN_INSTALL_COMMAND } };
  }
  if (features.devin && !features.devin.installCommand && !features.devin.skipInstall) {
    return {
      ...features,
      devin: { ...features.devin, installCommand: DEFAULT_DEVIN_INSTALL_COMMAND },
    };
  }
  return features;
}

/**
 * Resolves a set of enabled features into container-ready output:
 * install commands, hostPath volumes, volume mounts, and env vars.
 *
 * Usage:
 *   const output = resolveFeatures({
 *     homeDir: '/workspace',
 *     features: { devin: true, claude: { mountConfig: true } },
 *   });
 *   // output.installCommands, output.volumes, output.volumeMounts, output.env
 */
export function resolveFeatures(options: FeatureSetOptions): FeatureSetOutput {
  const { homeDir, hostHome } = options;
  const features = normalizeDevinInstall(options.features);

  const result: FeatureSetOutput = {
    installCommands: [],
    volumes: [],
    volumeMounts: [],
    env: [],
    featureIds: [],
  };

  for (const [featureId, rawProps] of Object.entries(features)) {
    if (rawProps === undefined) continue;
    const def = getFeatureDefinition(featureId as FeatureId);
    const props = normalizeProps(rawProps);

    result.featureIds.push(featureId as FeatureId);

    const installCommand = resolveInstallCommand(def, props);
    if (installCommand) {
      result.installCommands.push(installCommand);
    }

    const { volumes, volumeMounts } = resolveFeatureMounts(
      def,
      props,
      featureId as FeatureId,
      homeDir,
      hostHome,
    );
    result.volumes.push(...volumes);
    result.volumeMounts.push(...volumeMounts);

    result.env.push(...resolveFeatureEnv(props));
  }

  return result;
}

function normalizeProps(rawProps: FeatureProps | true): FeatureProps {
  return rawProps === true ? {} : rawProps;
}

function resolveInstallCommand(def: FeatureDefinition, props: FeatureProps): string | undefined {
  if (props.skipInstall) return undefined;
  return props.installCommand ?? def.installCommand;
}

function resolveFeatureMounts(
  def: FeatureDefinition,
  props: FeatureProps,
  featureId: FeatureId,
  homeDir: string,
  hostHome: string,
): {
  volumes: FeatureVolume[];
  volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
} {
  const volumes: FeatureVolume[] = [];
  const volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = [];
  const mountConfig = props.mountConfig ?? true;

  if (!mountConfig) {
    return { volumes, volumeMounts };
  }

  if (def.configDirs) {
    for (let i = 0; i < def.configDirs.length; i++) {
      const cfg = def.configDirs[i];
      const hostPath = resolveHostPath(cfg.hostPath, hostHome, mountConfig);
      const containerPath = cfg.containerPath ?? posix.join(homeDir, cfg.hostPath);
      const volName = `${featureId}-cfg-${i}`;

      volumes.push({
        name: volName,
        hostPath,
        mountPath: containerPath,
        type: 'DirectoryOrCreate',
        readOnly: cfg.readOnly ?? true,
      });
      volumeMounts.push({
        name: volName,
        mountPath: containerPath,
        readOnly: cfg.readOnly ?? true,
      });
    }
  }

  if (typeof mountConfig === 'object' && mountConfig.extra) {
    let extraIdx = 0;
    for (const [hostPath, containerPath] of Object.entries(mountConfig.extra)) {
      const volName = `${featureId}-extra-${extraIdx++}`;
      // Extra mounts may be files; leave type unset so Kubernetes accepts either.
      volumes.push({ name: volName, hostPath, mountPath: containerPath });
      volumeMounts.push({ name: volName, mountPath: containerPath });
    }
  }

  return { volumes, volumeMounts };
}

/** Resolve a host path — either from override or default $HOME/<path>. */
function resolveHostPath(
  defaultRelPath: string,
  hostHome: string,
  mountConfig: ShareOsConfig,
): string {
  if (typeof mountConfig === 'object' && mountConfig?.paths) {
    const override = mountConfig.paths[defaultRelPath];
    if (override) return override;
  }
  return join(hostHome, defaultRelPath);
}

function resolveFeatureEnv(props: FeatureProps): Array<{ name: string; value: string }> {
  if (!props.env) return [];
  return Object.entries(props.env).map(([name, value]) => ({ name, value }));
}

/** Get feature definitions for a set of feature ids. */
export function getFeatureDefs(featureIds: FeatureId[]): Readonly<FeatureDefinition>[] {
  return featureIds.map((id) => getFeatureDefinition(id));
}

/** Check if a feature is ACP-compatible (can be used as Omniroute ACP agent). */
export function isAcpCompatible(featureId: FeatureId): boolean {
  return getFeatureDefinition(featureId).acpCompatible ?? false;
}

/**
 * Build a startup script from install commands + a final exec command.
 *
 * The generated script uses bash (`set -euo pipefail`) so piped install commands
 * fail fast, and sets `NPM_CONFIG_PREFIX` to a user-writable directory when a
 * `homeDir` is supplied so global npm installs work for non-root users.
 */
export function buildStartupScript(
  installCommands: string[],
  execCommand: string,
  homeDir?: string,
): string {
  const lines = ['set -euo pipefail'];
  if (homeDir) {
    lines.push(`export HOME="${homeDir}"`);
    lines.push(`export NPM_CONFIG_PREFIX="${homeDir}/.local"`);
    // Include common installer bin directories (npm prefix, opencode, pipx/local).
    lines.push('export PATH="$NPM_CONFIG_PREFIX/bin:$HOME/.opencode/bin:$HOME/.local/bin:$PATH"');
  }
  for (const cmd of installCommands) {
    lines.push(cmd);
  }
  lines.push(`exec ${execCommand}`);
  return lines.join('\n');
}
