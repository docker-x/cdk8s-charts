import { homedir } from 'node:os';
import { join } from 'node:path';
import { getFeatureDefinition } from './agents/registry';
import type {
  FeatureDefinition,
  FeatureProps,
  FeatureSetOptions,
  FeatureSetOutput,
  FeatureVolume,
  ShareOsConfig,
} from './types';

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
  const { homeDir, features } = options;
  const hostHome = homedir();

  const installCommands: string[] = [];
  const volumes: FeatureVolume[] = [];
  const volumeMounts: Array<{ name: string; mountPath: string }> = [];
  const env: Array<{ name: string; value: string }> = [];
  const featureIds: string[] = [];

  for (const [featureId, featureProps] of Object.entries(features)) {
    const def = getFeatureDefinition(featureId);
    const props: FeatureProps = featureProps === true ? {} : featureProps;

    featureIds.push(featureId);

    // Install command
    if (!props.skipInstall) {
      installCommands.push(props.installCommand ?? def.installCommand);
    }

    // Config dir mounts
    const mountConfig = props.mountConfig ?? true;
    if (mountConfig && def.configDirs && def.configDirs.length > 0) {
      for (let i = 0; i < def.configDirs.length; i++) {
        const cfg = def.configDirs[i];
        const hostPath = resolveHostPath(cfg.hostPath, hostHome, mountConfig);
        const containerPath = cfg.containerPath ?? join(homeDir, cfg.hostPath);
        const volName = `${featureId}-cfg-${i}`;

        volumes.push({ name: volName, hostPath, mountPath: containerPath });
        volumeMounts.push({ name: volName, mountPath: containerPath });
      }
    }

    // Extra mounts from mountConfig.paths/extra
    if (typeof mountConfig === 'object' && mountConfig !== null) {
      if (mountConfig.extra) {
        let extraIdx = 0;
        for (const [hostPath, containerPath] of Object.entries(mountConfig.extra)) {
          const volName = `${featureId}-extra-${extraIdx++}`;
          volumes.push({ name: volName, hostPath, mountPath: containerPath });
          volumeMounts.push({ name: volName, mountPath: containerPath });
        }
      }
    }

    // Env vars
    if (props.env) {
      for (const [k, v] of Object.entries(props.env)) {
        env.push({ name: k, value: v });
      }
    }
  }

  return { installCommands, volumes, volumeMounts, env, featureIds };
}

/** Resolve a host path — either from override or default $HOME/<path>. */
function resolveHostPath(
  defaultRelPath: string,
  hostHome: string,
  mountConfig: ShareOsConfig,
): string {
  if (typeof mountConfig === 'object' && mountConfig !== null && mountConfig.paths) {
    const override = mountConfig.paths[defaultRelPath];
    if (override) return override;
  }
  return join(hostHome, defaultRelPath);
}

/** Get feature definitions for a set of feature ids. */
export function getFeatureDefs(featureIds: string[]): FeatureDefinition[] {
  return featureIds.map((id) => getFeatureDefinition(id));
}

/** Check if a feature is ACP-compatible (can be used as Omniroute ACP agent). */
export function isAcpCompatible(featureId: string): boolean {
  return getFeatureDefinition(featureId).acpCompatible ?? false;
}

/** Build a startup script from install commands + a final exec command. */
export function buildStartupScript(
  installCommands: string[],
  execCommand: string,
  preamble?: string,
): string {
  const lines = ['set -eu'];
  if (preamble) lines.push(preamble);
  for (const cmd of installCommands) {
    lines.push(cmd);
  }
  lines.push(`exec ${execCommand}`);
  return lines.join('\n');
}
