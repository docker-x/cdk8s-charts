import { dirname, relative, resolve } from 'node:path';
import { type CreateNodesV2, logger } from '@nx/devkit';

const PLUGIN_SCOPE = 'cdk8s-charts/cdk8s';
const SYNTH_COMMAND = 'npx cdk8s synth';

function isVerbose(): boolean {
  return (
    process.argv.includes('--verbose') ||
    process.env.NX_VERBOSE_LOGGING === 'true'
  );
}

function logDebug(message: string): void {
  if (isVerbose()) {
    logger.info(`[${PLUGIN_SCOPE}] ${message}`);
  }
}

export const createNodesV2: CreateNodesV2 = [
  '**/cdk8s.yaml',
  (configFiles, _options, context) => {
    const verbose = isVerbose();
    const workspaceRootAbs = context.workspaceRoot;

    if (verbose) {
      logger.info(`[${PLUGIN_SCOPE}] Processing ${configFiles.length} cdk8s.yaml files`);
    }

    return configFiles
      .map((configFile) => {
        const dir = dirname(configFile);
        const dirAbs = resolve(workspaceRootAbs, dir);
        if (dirAbs === workspaceRootAbs) {
          return null;
        }
        const projectRoot = relative(workspaceRootAbs, dirAbs).replace(/\\/g, '/');
        logDebug(`Found cdk8s.yaml in ${projectRoot}`);

        const synthTarget = {
          executor: 'nx:run-commands',
          options: {
            command: SYNTH_COMMAND,
            cwd: projectRoot,
          },
          outputs: ['{projectRoot}/dist'],
          inputs: [
            '{projectRoot}/cdk8s.yaml',
            '{projectRoot}/main.ts',
            '{projectRoot}/**/*.ts',
            '{projectRoot}/package.json',
          ],
        };

        return [
          configFile,
          {
            projects: {
              [projectRoot]: {
                targets: {
                  synth: synthTarget,
                },
              },
            },
          },
        ] as const;
      })
      .filter((result): result is NonNullable<typeof result> => result !== null);
  },
];
