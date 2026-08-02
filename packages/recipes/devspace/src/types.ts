/**
 * Types for DevSpace recipe - DevPod + Gascity + Nginx.
 */

// ---------------------------------------------------------------------------
// DevPod Config
// ---------------------------------------------------------------------------

export interface DevPodConfig {
  enabled?: boolean;
  storageSize?: string;
  password?: string;
}

// ---------------------------------------------------------------------------
// Gascity Config
// ---------------------------------------------------------------------------

export interface GascityConfig {
  enabled?: boolean;
  storageSize?: string;
  imageUrl?: string;
  withDashboard?: boolean;
  withSupervisor?: boolean;
  supervisorUrl?: string;
}

// ---------------------------------------------------------------------------
// Nginx Config
// ---------------------------------------------------------------------------

export interface NginxConfig {
  enabled?: boolean;
  listenPort?: number;
}

// ---------------------------------------------------------------------------
// OpenShift Config
// ---------------------------------------------------------------------------

export interface OpenShiftConfig {
  enabled?: boolean;
  createRoutes?: boolean;
}

// ---------------------------------------------------------------------------
// Construct props & exports
// ---------------------------------------------------------------------------

export interface DevSpaceProps {
  namespace: string;
  devpod?: DevPodConfig;
  gascity?: GascityConfig;
  nginx?: NginxConfig;
  openshift?: OpenShiftConfig;
}

export interface DevSpaceExports {
  /** DevPod service host. */
  devpodHost?: string;
  /** DevPod service port. */
  devpodPort?: number;
  /** Gascity dashboard host. */
  gascityDashboardHost?: string;
  /** Gascity dashboard port. */
  gascityDashboardPort?: number;
}
