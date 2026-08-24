import { readFileSync } from 'node:fs';
import type {
  AutoscalingConfig,
  DeepPartial,
  ResourceRequirements,
  Volume,
  VolumeMount,
} from '@cdk8s-charts/utils';
import { HelmConstruct } from '@cdk8s-charts/utils';
import { ApiObject } from 'cdk8s';
import type { Construct as IConstruct } from 'constructs';
import { Construct } from 'constructs';
import type {
  LitellmMsCallbacksProps,
  LitellmMsDatabaseEndpoint,
  LitellmMsDatabaseProps,
  LitellmMsEnvVar,
  LitellmMsExports,
  LitellmMsPostgresqlValues,
  LitellmMsProps,
  LitellmMsValues,
  LitellmMsVirtualKey,
} from './types';

const DEFAULT_CHART = 'oci://ghcr.io/berriai/litellm/chart/litellm';
const DEFAULT_VERSION = '1.98.0';
const DEFAULT_POSTGRES_CHART = 'oci://registry-1.docker.io/bitnamicharts/postgresql';
const CURL_IMAGE = 'curlimages/curl:8.12.1';

const WAIT_FOR_LITELLM_SCRIPT = readFileSync(
  new URL('./scripts/wait-for-litellm.sh', import.meta.url),
  'utf8',
);
const PROVISION_KEYS_SCRIPT = readFileSync(
  new URL('./scripts/provision-keys.sh', import.meta.url),
  'utf8',
);

const CONFIGMAP_KEY_RE = /^[a-zA-Z0-9._-]+$/;

const HPA_DISABLED: AutoscalingConfig = { enabled: false };
const DEFAULT_RESOURCES: ResourceRequirements = {
  requests: { cpu: '100m', memory: '512Mi' },
  limits: { cpu: '1', memory: '2Gi' },
};
const UI_RESOURCES: ResourceRequirements = {
  requests: { cpu: '50m', memory: '128Mi' },
  limits: { cpu: '500m', memory: '512Mi' },
};

function validateCallbackFileNames(id: string, callbacks: LitellmMsCallbacksProps): void {
  for (const fileName of Object.keys(callbacks.files)) {
    if (fileName === '.' || fileName === '..') {
      throw new Error(`${id}: callback filename cannot be '.' or '..' (${fileName})`);
    }
    if (fileName.length > 253) {
      throw new Error(`${id}: callback filename exceeds 253 characters (${fileName})`);
    }
    if (!CONFIGMAP_KEY_RE.test(fileName)) {
      throw new Error(
        `${id}: callback filename must match /^[a-zA-Z0-9._-]+$/ (${fileName}); it is used as a ConfigMap key and subPath`,
      );
    }
  }
}

function validateVirtualKeys(id: string, keys: LitellmMsVirtualKey[]): void {
  const seen = new Set<string>();
  for (const { alias } of keys) {
    if (!alias?.trim()) {
      throw new Error(`${id}: virtual key alias must be non-empty`);
    }
    if (seen.has(alias)) {
      throw new Error(`${id}: duplicate virtual key alias "${alias}"`);
    }
    seen.add(alias);
  }
}

function validateProps(
  id: string,
  props: LitellmMsProps,
  db: LitellmMsDatabaseProps,
  deployPostgres: boolean,
): void {
  if (deployPostgres && !db.password) {
    throw new Error(`${id}: database.password is required when embedded PostgreSQL is enabled`);
  }
  if (props.callbacks) {
    validateCallbackFileNames(id, props.callbacks);
  }
  if (props.virtualKeys) {
    validateVirtualKeys(id, props.virtualKeys);
  }
}

/**
 * LiteLLM microservices chart (gateway + backend + ui).
 *
 * Wraps oci://ghcr.io/berriai/litellm/chart/litellm — the componentized deployment
 * documented at https://docs.litellm.ai/docs/proxy/deploy#deploy-with-helm
 */
export class LitellmMs extends HelmConstruct<LitellmMsValues> {
  public readonly exports: LitellmMsExports;

  constructor(scope: IConstruct, id: string, props: LitellmMsProps) {
    super(scope, id);

    const db = props.database ?? {};
    const deployPostgres = db.enabled !== false;
    const dbUser = db.username ?? 'litellm';
    const dbName = db.database ?? 'litellm';
    const masterSecret = `${id}-masterkey`;
    const redisSecret = `${id}-redis`;
    const postgresRelease = `${id}-postgresql`;

    validateProps(id, props, db, deployPostgres);

    this.createMasterAndRedisSecrets(props.namespace, props, masterSecret, redisSecret);
    const envSecretName = this.createEnvSecretIfNeeded(id, props.namespace, props);
    const dbSecretName = this.createDbSecretIfNeeded(id, props.namespace, db, dbUser);

    const databaseConfig = this.resolveDatabaseConfig({
      id,
      namespace: props.namespace,
      deployPostgres,
      db,
      dbUser,
      dbName,
      postgresRelease,
      dbSecretName,
    });
    const callbacks = this.buildGatewayCallbacks(id, props.namespace, props.callbacks);

    // Merge generated callback volumes/mounts with any user-supplied ones for
    // gateway and backend so overrides cannot drop one side of a volume/mount
    // pair (deepMerge replaces arrays rather than concatenating them).
    const userGatewayVolumes = (props.values?.gateway?.volumes as Volume[] | undefined) ?? [];
    const userGatewayMounts =
      (props.values?.gateway?.volumeMounts as VolumeMount[] | undefined) ?? [];
    const userBackendVolumes = props.values?.backend?.volumes as Volume[] | undefined;
    const userBackendMounts = props.values?.backend?.volumeMounts as VolumeMount[] | undefined;

    const computed = this.buildComputedValues(props, {
      id,
      dbName,
      masterSecret,
      redisSecret,
      envSecretName,
      ...databaseConfig,
      gatewayVolumes: [...callbacks.gatewayVolumes, ...userGatewayVolumes],
      gatewayMounts: [...callbacks.gatewayMounts, ...userGatewayMounts],
      backendVolumes:
        userBackendVolumes === undefined
          ? undefined
          : [...callbacks.gatewayVolumes, ...userBackendVolumes],
      backendMounts:
        userBackendMounts === undefined
          ? undefined
          : [...callbacks.gatewayMounts, ...userBackendMounts],
    });

    const values = this.renderChart(
      props.chart ?? DEFAULT_CHART,
      id,
      props.namespace,
      computed,
      this.stripVolumeOverrides(props.values),
      { helmFlags: ['--skip-tests'], version: props.version ?? DEFAULT_VERSION },
    );

    this.exports = this.buildExports(id, values, props.masterKey, props.virtualKeys);
    if (props.virtualKeys?.length) {
      this.createKeyProvisioningJob(
        id,
        props.namespace,
        masterSecret,
        this.exports.backendHost,
        this.exports.backendPort,
        props.virtualKeys,
      );
    }
  }

  private createSecret(
    logicalId: string,
    name: string,
    namespace: string,
    stringData: Record<string, string>,
  ): void {
    new ApiObject(this, logicalId, {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace },
      stringData,
    });
  }

  private createConfigMap(
    logicalId: string,
    name: string,
    namespace: string,
    data: Record<string, string>,
  ): void {
    new ApiObject(this, logicalId, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace },
      data,
    });
  }

  private createMasterAndRedisSecrets(
    namespace: string,
    props: LitellmMsProps,
    masterSecret: string,
    redisSecret: string,
  ): void {
    this.createSecret('masterkey', masterSecret, namespace, { 'master-key': props.masterKey });
    this.createSecret('redis-secret', redisSecret, namespace, { password: props.redis.password });
  }

  private createEnvSecretIfNeeded(
    id: string,
    namespace: string,
    props: LitellmMsProps,
  ): string | undefined {
    const envStringData: Record<string, string> = {};
    if (props.saltKey) {
      envStringData.LITELLM_SALT_KEY = props.saltKey;
    }
    if (props.env) {
      Object.assign(envStringData, props.env);
    }
    if (Object.keys(envStringData).length === 0) {
      return undefined;
    }
    const envSecret = `${id}-env`;
    this.createSecret('env', envSecret, namespace, envStringData);
    return envSecret;
  }

  private createDbSecretIfNeeded(
    id: string,
    namespace: string,
    db: LitellmMsDatabaseProps,
    dbUser: string,
  ): string {
    const dbSecret = `${id}-db`;
    if (db.password) {
      this.createSecret('db-secret', dbSecret, namespace, {
        username: dbUser,
        password: db.password,
      });
    }
    return dbSecret;
  }

  private resolveDatabaseConfig(options: {
    id: string;
    namespace: string;
    deployPostgres: boolean;
    db: LitellmMsDatabaseProps;
    dbUser: string;
    dbName: string;
    postgresRelease: string;
    dbSecretName: string;
  }): {
    dbHost: string;
    dbPasswordSecretName: string;
    dbPasswordUsernameKey: string;
    dbPasswordPasswordKey: string;
  } {
    const { id, namespace, deployPostgres, db, dbUser, dbName, postgresRelease, dbSecretName } =
      options;

    if (deployPostgres) {
      const postgresScope = new Construct(this, 'postgresql');
      const postgresComputed: LitellmMsPostgresqlValues = {
        auth: { username: dbUser, password: db.password, database: dbName },
        primary: { persistence: { enabled: true } },
      };
      const postgresValues = this.renderChartOn(
        postgresScope,
        db.chart ?? DEFAULT_POSTGRES_CHART,
        postgresRelease,
        namespace,
        postgresComputed,
        db.values,
        { version: db.version, helmFlags: ['--skip-tests'] },
      );
      return {
        dbHost: LitellmMs.getPostgresHost(postgresRelease, postgresValues),
        dbPasswordSecretName: dbSecretName,
        dbPasswordUsernameKey: 'username',
        dbPasswordPasswordKey: 'password',
      };
    }

    if (!db.host) {
      throw new Error(`${id}: database.host is required when embedded PostgreSQL is disabled`);
    }

    if (db.password) {
      return {
        dbHost: db.host,
        dbPasswordSecretName: dbSecretName,
        dbPasswordUsernameKey: 'username',
        dbPasswordPasswordKey: 'password',
      };
    }

    if (db.existingSecret?.name) {
      return {
        dbHost: db.host,
        dbPasswordSecretName: db.existingSecret.name,
        dbPasswordUsernameKey: db.existingSecret.usernameKey ?? 'username',
        dbPasswordPasswordKey: db.existingSecret.passwordKey ?? 'password',
      };
    }

    throw new Error(
      `${id}: database.password or database.existingSecret is required for an external PostgreSQL writer`,
    );
  }

  private buildGatewayCallbacks(
    id: string,
    namespace: string,
    callbacks?: LitellmMsCallbacksProps,
  ): { gatewayVolumes: Volume[]; gatewayMounts: VolumeMount[] } {
    const gatewayVolumes: Volume[] = [];
    const gatewayMounts: VolumeMount[] = [];
    if (!callbacks || Object.keys(callbacks.files).length === 0) {
      return { gatewayVolumes, gatewayMounts };
    }

    const callbacksName = `${id}-callbacks`;
    this.createConfigMap('callbacks', callbacksName, namespace, callbacks.files);
    gatewayVolumes.push({ name: 'callbacks', configMap: { name: callbacksName } });
    for (const fileName of Object.keys(callbacks.files)) {
      gatewayMounts.push({
        name: 'callbacks',
        mountPath: `${callbacks.mountPath}/${fileName}`,
        subPath: fileName,
      });
    }
    return { gatewayVolumes, gatewayMounts };
  }

  private buildComputedValues(
    props: LitellmMsProps,
    options: {
      id: string;
      dbName: string;
      masterSecret: string;
      redisSecret: string;
      envSecretName?: string;
      dbHost: string;
      dbPasswordSecretName: string;
      dbPasswordUsernameKey: string;
      dbPasswordPasswordKey: string;
      gatewayVolumes: Volume[];
      gatewayMounts: VolumeMount[];
      backendVolumes?: Volume[];
      backendMounts?: VolumeMount[];
    },
  ): LitellmMsValues {
    const svcType = props.serviceType ?? 'ClusterIP';
    const envSecrets: string[] = props.envSecretNames ? [...props.envSecretNames] : [];
    if (options.envSecretName) {
      envSecrets.push(options.envSecretName);
    }

    const dbWriter: LitellmMsDatabaseEndpoint = {
      host: options.dbHost,
      port: props.database?.port ?? 5432,
      dbname: options.dbName ?? 'litellm',
      passwordSecret: {
        name: options.dbPasswordSecretName,
        usernameKey: options.dbPasswordUsernameKey,
        passwordKey: options.dbPasswordPasswordKey,
      },
    };
    if (props.database?.schema) {
      dbWriter.schema = props.database.schema;
    }

    const backendVolumes = options.backendVolumes ?? options.gatewayVolumes;
    const backendMounts = options.backendMounts ?? options.gatewayMounts;

    const gatewayExtra = {
      ...(options.gatewayVolumes.length > 0 ? { volumes: options.gatewayVolumes } : {}),
      ...(options.gatewayMounts.length > 0 ? { volumeMounts: options.gatewayMounts } : {}),
    };
    const backendExtra = {
      ...(backendVolumes.length > 0 ? { volumes: backendVolumes } : {}),
      ...(backendMounts.length > 0 ? { volumeMounts: backendMounts } : {}),
    };

    return {
      fullnameOverride: options.id,
      masterKey: { secretName: options.masterSecret, secretKey: 'master-key' },
      database: { writer: dbWriter },
      redis: {
        host: props.redis.host,
        port: props.redis.port,
        passwordSecret: { name: options.redisSecret, passwordKey: 'password' },
      },
      gateway: {
        config: { create: true, proxy_config: props.proxyConfig },
        envSecrets,
        ...gatewayExtra,
        service: { type: svcType, port: 4000 },
        hpa: HPA_DISABLED,
        resources: DEFAULT_RESOURCES,
      },
      backend: {
        envSecrets,
        ...backendExtra,
        service: { type: 'ClusterIP', port: 4001 },
        hpa: HPA_DISABLED,
        resources: DEFAULT_RESOURCES,
      },
      ui: {
        service: { type: svcType, port: 3000 },
        hpa: HPA_DISABLED,
        resources: UI_RESOURCES,
      },
      migrationJob: { enabled: true },
    };
  }

  private stripVolumeOverrides(
    values: DeepPartial<LitellmMsValues> | undefined,
  ): DeepPartial<LitellmMsValues> | undefined {
    if (!values) return undefined;
    const { gateway, backend, ...rest } = values;
    const overrides: DeepPartial<LitellmMsValues> = { ...rest };
    if (gateway) {
      const { volumes: _v, volumeMounts: _vm, ...gatewayRest } = gateway;
      if (Object.keys(gatewayRest).length > 0) {
        overrides.gateway = gatewayRest;
      }
    }
    if (backend) {
      const { volumes: _v, volumeMounts: _vm, ...backendRest } = backend;
      if (Object.keys(backendRest).length > 0) {
        overrides.backend = backendRest;
      }
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  private buildExports(
    id: string,
    values: LitellmMsValues,
    masterKey: string,
    virtualKeys?: LitellmMsVirtualKey[],
  ): LitellmMsExports {
    const fullname = values.fullnameOverride ?? id;
    const gatewayPort = values.gateway?.service?.port ?? 4000;
    const backendPort = values.backend?.service?.port ?? 4001;
    const uiPort = values.ui?.service?.port ?? 3000;
    const gatewayHost = `${fullname}-gateway`;
    const backendHost = `${fullname}-backend`;
    const uiHost = `${fullname}-ui`;

    const virtualKeyMap: Record<string, string> = {};
    if (virtualKeys) {
      for (const vk of virtualKeys) {
        virtualKeyMap[vk.alias] = vk.key;
      }
    }

    return {
      gatewayHost,
      gatewayPort,
      backendHost,
      backendPort,
      uiHost,
      uiPort,
      masterKey,
      virtualKeys: virtualKeyMap,
      host: gatewayHost,
      port: gatewayPort,
    };
  }

  private static getPostgresHost(releaseName: string, values: LitellmMsPostgresqlValues): string {
    const serviceName = values.primary?.service?.name;
    if (serviceName) {
      return serviceName;
    }
    const fullname =
      values.global?.postgresql?.fullnameOverride ?? values.fullnameOverride ?? releaseName;
    if (values.architecture === 'replication') {
      return `${fullname}-${values.primary?.name ?? 'primary'}`;
    }
    return fullname;
  }

  private createCurlContainer(
    name: string,
    script: string,
    baseUrl: string,
    extraEnv: LitellmMsEnvVar[],
    volumeMounts: VolumeMount[],
  ) {
    return {
      name,
      image: CURL_IMAGE,
      command: ['sh', `/scripts/${script}`],
      env: [{ name: 'LITELLM_BASE_URL', value: baseUrl }, ...extraEnv],
      volumeMounts,
    };
  }

  private createKeyProvisioningJob(
    releaseName: string,
    namespace: string,
    masterSecretName: string,
    host: string,
    port: number,
    keys: LitellmMsVirtualKey[],
  ): void {
    const baseUrl = `http://${host}:${port}`;
    const scriptConfigMapName = `${releaseName}-provision-keys-scripts`;
    const payloadSecretName = `${releaseName}-provision-keys-data`;
    const keySpecs: string[] = [];
    const payloadFiles: Record<string, string> = {};

    keys.forEach((vk, index) => {
      const fileName = `key-${index}.json`;
      payloadFiles[fileName] = JSON.stringify({
        key_alias: vk.alias,
        key: vk.key,
        ...(vk.models ? { models: vk.models } : {}),
        ...(vk.max_budget !== undefined ? { max_budget: vk.max_budget } : {}),
      });
      keySpecs.push(`${vk.alias}\t${fileName}`);
    });

    this.createConfigMap('provision-scripts', scriptConfigMapName, namespace, {
      'wait-for-litellm.sh': WAIT_FOR_LITELLM_SCRIPT,
      'provision-keys.sh': PROVISION_KEYS_SCRIPT,
    });
    this.createSecret('provision-data', payloadSecretName, namespace, payloadFiles);

    const scriptVolumeMount: VolumeMount = {
      name: 'provision-scripts',
      mountPath: '/scripts',
      readOnly: true,
    };
    const waitContainer = this.createCurlContainer(
      'wait-for-litellm',
      'wait-for-litellm.sh',
      baseUrl,
      [
        { name: 'LITELLM_WAIT_RETRIES', value: '60' },
        { name: 'LITELLM_WAIT_SLEEP_SECONDS', value: '5' },
      ],
      [scriptVolumeMount],
    );
    const provisionContainer = this.createCurlContainer(
      'provision',
      'provision-keys.sh',
      baseUrl,
      [
        {
          name: 'LITELLM_MASTER_KEY',
          valueFrom: { secretKeyRef: { name: masterSecretName, key: 'master-key' } },
        },
        { name: 'LITELLM_KEY_SPECS', value: keySpecs.join('\n') },
        { name: 'LITELLM_KEY_DIR', value: '/keys' },
      ],
      [scriptVolumeMount, { name: 'provision-data', mountPath: '/keys', readOnly: true }],
    );

    new ApiObject(this, 'provision-keys', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${releaseName}-provision-keys`,
        namespace,
        annotations: {
          'helm.sh/hook': 'post-install,post-upgrade',
          'helm.sh/hook-delete-policy': 'before-hook-creation,hook-succeeded',
        },
      },
      spec: {
        backoffLimit: 5,
        ttlSecondsAfterFinished: 300,
        template: {
          spec: {
            initContainers: [waitContainer],
            containers: [provisionContainer],
            restartPolicy: 'OnFailure',
            volumes: [
              {
                name: 'provision-scripts',
                configMap: { name: scriptConfigMapName, defaultMode: 0o755 },
              },
              {
                name: 'provision-data',
                secret: { secretName: payloadSecretName, defaultMode: 0o644 },
              },
            ],
          },
        },
      },
    });
  }
}
