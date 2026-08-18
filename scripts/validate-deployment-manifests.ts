const repositoryRoot = import.meta.dir.replace(/\/scripts$/, "");
const environments = ["development", "preview", "production"] as const;
const deployables = [
  "api",
  "deletion-coordinator",
  "provider-control",
  "restore-coordinator",
] as const;
const oauthKvValidationId = "22222222222222222222222222222222";
const requiredApiCrons = ["* * * * *", "*/5 * * * *", "0 * * * *"].sort();

const manifestConfigurations = (manifest: Record<string, unknown>) => [
  ["top level", manifest] as const,
  ...Object.entries(
    (manifest.env as Record<string, Record<string, unknown>> | undefined) ?? {},
  ),
];

const requiredSecrets = (configuration: Record<string, unknown>) =>
  [
    ...((configuration.secrets as { readonly required?: ReadonlyArray<string> })
      ?.required ?? []),
  ].sort();

const configuredCrons = (configuration: Record<string, unknown>) =>
  [
    ...((configuration.triggers as { readonly crons?: ReadonlyArray<string> })
      ?.crons ?? []),
  ].sort();

const hasSameStrings = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const assertAbsent = (
  configuration: Record<string, unknown>,
  keys: ReadonlyArray<string>,
  errorFor: (key: string) => string,
) => {
  for (const key of keys) {
    if (key in configuration) throw new Error(errorFor(key));
  }
};

const findQueueConsumer = (
  configuration: Record<string, unknown>,
  queue: string,
) =>
  (
    configuration.queues as
      | { readonly consumers?: ReadonlyArray<Record<string, unknown>> }
      | undefined
  )?.consumers?.find((consumer) => consumer.queue === queue);

for (const deployable of deployables) {
  const manifestPath = `${repositoryRoot}/apps/${deployable}/wrangler.jsonc`;
  const manifest = Bun.JSONC.parse(
    await Bun.file(manifestPath).text(),
  ) as Record<string, unknown>;

  if (deployable === "provider-control") {
    const requiredSecretNames = [
      "WASENDER_API_CREDENTIAL",
      "WASENDER_REFERENCE_SECRET",
    ].sort();
    const forbiddenAuthority = [
      "d1_databases",
      "durable_objects",
      "hyperdrive",
      "kv_namespaces",
      "queues",
      "r2_buckets",
      "services",
    ];
    const configurations = manifestConfigurations(manifest);
    for (const [configurationName, configuration] of configurations) {
      assertAbsent(
        configuration,
        forbiddenAuthority,
        (key) =>
          `Provider-control must not declare ${key}; it receives lifecycle secrets only.`,
      );
      if (
        !hasSameStrings(requiredSecrets(configuration), requiredSecretNames)
      ) {
        throw new Error(
          `Provider-control ${configurationName} configuration must require both lifecycle secrets.`,
        );
      }
    }
  } else if (deployable === "deletion-coordinator") {
    const configurations = manifestConfigurations(manifest);
    const required = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "DELETION_COORDINATOR_DATABASE_URL",
      "KMS_DELETION_COORDINATOR_KEY_ARN",
    ].sort();
    for (const [name, configuration] of configurations) {
      if (!hasSameStrings(requiredSecrets(configuration), required)) {
        throw new Error(
          `Deletion coordinator ${name} must require its isolated KMS and database credentials.`,
        );
      }
      assertAbsent(
        configuration,
        ["hyperdrive", "kv_namespaces", "queues"],
        (key) => `Deletion coordinator must not declare ${key}.`,
      );
    }
  } else if (deployable === "restore-coordinator") {
    const configurations = manifestConfigurations(manifest);
    const required = [
      "DELETION_MARKER_HMAC_SECRET",
      "NEON_BRANCH_ID",
      "RECIPIENT_TRANSITION_HMAC_SECRET",
      "RESTORE_DATABASE_URL",
    ].sort();
    for (const [name, configuration] of configurations) {
      if (!hasSameStrings(requiredSecrets(configuration), required)) {
        throw new Error(
          `Restore coordinator ${name} must require only its marker and restricted database credentials.`,
        );
      }
      assertAbsent(
        configuration,
        [
          "d1_databases",
          "durable_objects",
          "hyperdrive",
          "kv_namespaces",
          "queues",
          "services",
        ],
        (key) => `Restore coordinator must not declare ${key}.`,
      );
    }
  } else {
    const requiredSecretNames = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "CLERK_JWT_KEY",
      "CLERK_SECRET_KEY",
      "CLERK_WEBHOOK_SIGNING_SECRET",
      "DELETION_MARKER_HMAC_SECRET",
      "KMS_CONTENT_ROOT_KEY_ARN",
      "KMS_DELETION_COORDINATOR_KEY_ARN",
      "API_KEY_HMAC_SECRET",
      "MCP_CURSOR_HMAC_SECRET",
      "OAUTH_PROTOCOL_ENCRYPTION_KEY",
      "RECIPIENT_TRANSITION_HMAC_SECRET",
      "SEND_FINGERPRINT_HMAC_SECRET",
      "SMOKE_CHECK_SECRET",
      "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
    ].sort();
    const configurations = manifestConfigurations(manifest);
    for (const [configurationName, configuration] of configurations) {
      const placement = configuration.placement as
        | { readonly region?: unknown }
        | undefined;
      if (placement?.region !== "aws:us-east-1") {
        throw new Error(
          `API ${configurationName} configuration must run beside the regional database to keep MCP query round trips low latency.`,
        );
      }
      if (
        !hasSameStrings(requiredSecrets(configuration), requiredSecretNames)
      ) {
        throw new Error(
          `API ${configurationName} configuration must require its exact identity, KMS, database, cursor, send fingerprint, deployed smoke, OAuth protocol, and WhatsApp Number reservation secrets.`,
        );
      }
      const environmentSuffix =
        configurationName === "top level" || configurationName === "production"
          ? ""
          : `-${configurationName}`;
      if (!hasSameStrings(configuredCrons(configuration), requiredApiCrons)) {
        throw new Error(
          `API ${configurationName} configuration must schedule minute recovery, five-minute reconciliation, and hourly retention.`,
        );
      }
      const ingestion = findQueueConsumer(
        configuration,
        `whatsapp-mcp-ingestion${environmentSuffix}`,
      );
      const deadLetter = findQueueConsumer(
        configuration,
        `whatsapp-mcp-ingestion-dlq${environmentSuffix}`,
      );
      const replay = findQueueConsumer(
        configuration,
        `whatsapp-mcp-ingestion-replay${environmentSuffix}`,
      );
      if (
        ingestion?.dead_letter_queue !==
          `whatsapp-mcp-ingestion-dlq${environmentSuffix}` ||
        ingestion.max_retries !== 7 ||
        ingestion.retry_delay !== 10_800 ||
        deadLetter?.max_retries !== 100 ||
        deadLetter?.retry_delay !== 300 ||
        replay?.max_retries !== 100 ||
        replay?.retry_delay !== 300
      ) {
        throw new Error(
          `API ${configurationName} configuration must bound ingestion at seven three-hour retries and give active DLQ and immutable replay handling the maximum retry budget.`,
        );
      }
    }
    const compatibilityFlags = manifest.compatibility_flags;
    if (
      !Array.isArray(compatibilityFlags) ||
      !compatibilityFlags.includes("global_fetch_strictly_public") ||
      !compatibilityFlags.includes("nodejs_compat")
    ) {
      throw new Error(
        "API must enable Node.js compatibility and strict public global fetch.",
      );
    }
  }

  if (
    manifest.workers_dev !== false ||
    manifest.preview_urls !== false ||
    "route" in manifest ||
    "routes" in manifest
  ) {
    throw new Error(
      `${deployable} must expose no Wrangler-managed public ingress; OpenTofu owns the API custom domain.`,
    );
  }

  const validatedEnvironments =
    deployable === "restore-coordinator"
      ? (["production"] as const)
      : environments;
  for (const environment of validatedEnvironments) {
    const workerSuffix = environment === "production" ? "" : `-${environment}`;
    const outputDirectory = `${repositoryRoot}/.wrangler/manifest-validation/${deployable}-${environment}`;
    let configPath = manifestPath;

    if (deployable === "api") {
      configPath = `${repositoryRoot}/.wrangler/manifest-validation/api-${environment}.jsonc`;
      const renderer = Bun.spawn(
        ["bun", "scripts/render-api-wrangler.ts", configPath, environment],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            CLOUDFLARE_HYPERDRIVE_ID: "00000000000000000000000000000000",
            CLOUDFLARE_OAUTH_KV_ID: oauthKvValidationId,
            CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID:
              "11111111111111111111111111111111",
            CLERK_API_AUDIENCE: "https://api.example.test",
            CLERK_AUTHORIZED_PARTY: "https://app.example.test",
            CLERK_ISSUER: "https://clerk.example.test",
            DECRYPTED_MEDIA_BYTES_PER_DAY: "268435456",
            OAUTH_ISSUER: "https://api.example.test",
            OAUTH_RESOURCE: "https://api.example.test/mcp",
            MCP_REQUESTS_PER_HOUR: "600",
            MCP_REQUESTS_PER_MINUTE: "60",
            NEON_BRANCH_ID: "br-manifest-validation",
            READ_MESSAGE_RECORDS_PER_DAY: "10000",
            SENDS_PER_DAY: "200",
            SENDS_PER_MINUTE: "10",
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [rendererExitCode, rendererStdout, rendererStderr] =
        await Promise.all([
          renderer.exited,
          new Response(renderer.stdout).text(),
          new Response(renderer.stderr).text(),
        ]);
      if (rendererExitCode !== 0) {
        console.error(`${rendererStdout}\n${rendererStderr}`);
        throw new Error(`Could not render API ${environment} bindings.`);
      }
    }

    const process = Bun.spawn(
      [
        "bun",
        "run",
        "--cwd",
        `apps/${deployable}`,
        "wrangler",
        "deploy",
        "--dry-run",
        "--config",
        configPath,
        "--env",
        environment,
        "--outdir",
        outputDirectory,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...Bun.env,
          CI: "true",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    if (exitCode !== 0) {
      console.error(output);
      throw new Error(
        `Wrangler rejected ${deployable}'s ${environment} manifest.`,
      );
    }

    const environmentBinding =
      deployable === "deletion-coordinator"
        ? "ENVIRONMENT"
        : "DEPLOYMENT_ENVIRONMENT";
    if (!output.includes(`env.${environmentBinding} ("${environment}")`)) {
      throw new Error(
        `${deployable}'s ${environment} manifest has the wrong environment binding.`,
      );
    }

    if (
      deployable === "api" &&
      !output.includes(
        `env.PROVIDER_CONTROL (whatsapp-mcp-provider-control${workerSuffix})`,
      )
    ) {
      throw new Error(
        `API ${environment} does not bind to provider-control in the same environment.`,
      );
    }

    if (
      deployable === "deletion-coordinator" &&
      !output.includes(
        `env.PROVIDER_CONTROL (whatsapp-mcp-provider-control${workerSuffix})`,
      )
    ) {
      throw new Error(
        `Deletion coordinator ${environment} is not bound to provider-control.`,
      );
    }

    if (deployable === "api") {
      for (const binding of [
        'env.CLERK_API_AUDIENCE ("https://api.example.test")',
        'env.CLERK_AUTHORIZED_PARTY ("https://app.example.test")',
        'env.CLERK_ISSUER ("https://clerk.example.test")',
        'env.OAUTH_ISSUER ("https://api.example.test")',
        'env.OAUTH_RESOURCE ("https://api.example.test/mcp")',
        'env.MCP_REQUESTS_PER_HOUR ("600")',
        'env.MCP_REQUESTS_PER_MINUTE ("60")',
        'env.READ_MESSAGE_RECORDS_PER_DAY ("10000")',
        'env.DECRYPTED_MEDIA_BYTES_PER_DAY ("268435456")',
      ]) {
        if (!output.includes(binding)) {
          throw new Error(
            `API ${environment} is missing required binding ${binding}.`,
          );
        }
      }
      const requiredBindings = [
        `env.OAUTH_KV (${oauthKvValidationId})`,
        "env.HYPERDRIVE (00000000000000000000000000000000)",
        "env.WEBHOOK_HYPERDRIVE (11111111111111111111111111111111)",
        `env.CONNECTION_SETUP_PROVISIONING_QUEUE (whatsapp-mcp-connection-setup-provisioning${workerSuffix})`,
        `env.INGESTION_QUEUE (whatsapp-mcp-ingestion${workerSuffix})`,
        `env.WEBHOOK_INGRESS (whatsapp-mcp-webhook-ingress${workerSuffix})`,
        `env.STORED_MEDIA (whatsapp-mcp-stored-media${workerSuffix})`,
        `env.DELETION_CAPSULES (whatsapp-mcp-deletion-capsules${workerSuffix})`,
        `env.DELETION_MARKERS (whatsapp-mcp-deletion-markers${workerSuffix})`,
        `env.RECIPIENT_TRANSITIONS (whatsapp-mcp-recipient-transitions${workerSuffix})`,
      ];
      for (const binding of requiredBindings) {
        if (!output.includes(binding)) {
          throw new Error(
            `API ${environment} is missing required binding ${binding}.`,
          );
        }
      }
    } else if (
      deployable === "provider-control" &&
      ["KV Namespace", "Queue", "R2 Bucket"].some((resource) =>
        output.includes(resource),
      )
    ) {
      throw new Error(
        `Provider-control ${environment} must receive no OAuth, Queue, or R2 authority.`,
      );
    } else if (deployable === "restore-coordinator") {
      for (const binding of [
        `env.DELETION_MARKERS (whatsapp-mcp-deletion-markers${workerSuffix})`,
        `env.RECIPIENT_TRANSITIONS (whatsapp-mcp-recipient-transitions${workerSuffix})`,
        `env.STORED_MEDIA (whatsapp-mcp-stored-media${workerSuffix})`,
        `env.WEBHOOK_INGRESS (whatsapp-mcp-webhook-ingress${workerSuffix})`,
      ]) {
        if (!output.includes(binding)) {
          throw new Error(
            `Restore coordinator ${environment} is missing required binding ${binding}.`,
          );
        }
      }
    }
  }
}

for (const app of ["web", "docs"] as const) {
  const vercelManifest = JSON.parse(
    await Bun.file(`${repositoryRoot}/apps/${app}/vercel.json`).text(),
  ) as Record<string, unknown>;
  if ("rewrites" in vercelManifest || "routes" in vercelManifest) {
    throw new Error(`The Vercel ${app} deployment must not proxy API traffic.`);
  }
}

console.info(
  "Wrangler manifests validated for development, preview, and production.",
);
