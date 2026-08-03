# @cdk8s-charts/otel-lgtm

Deploys Grafana's `grafana/otel-lgtm` all-in-one development backend as a
typed cdk8s construct. The image includes Grafana, Loki, Tempo, Prometheus,
and the OpenTelemetry Collector.

```ts
new OtelLgtm(this, 'observability', {
  namespace: 'dev',
  serviceType: 'LoadBalancer',
  dataSize: '10Gi',
});
```

This construct is intended for local development and demos. For production,
deploy the individual Grafana component charts instead.
