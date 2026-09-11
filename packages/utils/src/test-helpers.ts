import { Testing } from 'cdk8s';

/** A synthesized Kubernetes manifest with minimal typed accessors. */
export type Manifest = Record<string, unknown>;

/** Find a synthesized Kubernetes manifest by kind and optional name. Throws if not found. */
export function findManifest(manifests: object[], kind: string, name?: string): Manifest {
  const found = manifests.find((m): boolean => {
    const obj = m as Manifest;
    return (
      obj.kind === kind && (!name || (obj.metadata as { name?: string } | undefined)?.name === name)
    );
  });
  if (!found) throw new Error(`Expected ${kind}${name ? ` named ${name}` : ''} not found`);
  return found as Manifest;
}

/** Filter manifests by kind. */
export function filterByKind(manifests: object[], kind: string): Manifest[] {
  return manifests.filter((m) => (m as Manifest).kind === kind);
}

/** Synthesize a cdk8s Chart subclass for testing. */
export function synthChart<T extends { synth(): Manifest[] }>(chart: T): Manifest[] {
  return Testing.synth(chart as unknown as Parameters<typeof Testing.synth>[0]);
}
