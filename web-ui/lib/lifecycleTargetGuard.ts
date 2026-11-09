import path from "node:path";

export const PROD_HOST_RUNNER_PORT = 8765;
export const PROD_CONFIG_DIR = "C:\\AI\\ai-control";

export interface SacrificialTargetOptions {
  port: number;
  configDir?: string;
}

export interface SacrificialTargetResult {
  safe: boolean;
  port: number;
  configDir?: string;
}

/**
 * Hard guard asserting that a lifecycle test target is strictly sacrificial
 * and never touches or points to the production host runner port (8765)
 * or production configuration directory (C:\AI\ai-control).
 */
export function assertSacrificialTarget(options: SacrificialTargetOptions): SacrificialTargetResult {
  const { port, configDir } = options;

  if (typeof port !== "number" || isNaN(port) || port <= 1024 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be a valid non-privileged port between 1025 and 65535.`);
  }

  if (port === PROD_HOST_RUNNER_PORT) {
    throw new Error(
      `Production target guard rejection: port ${port} is the protected production host runner port. Refusing to run lifecycle test against production runner.`
    );
  }

  if (configDir) {
    const normalizedTarget = path.resolve(configDir).replace(/\\/g, "/").toLowerCase();
    const normalizedProd = path.resolve(PROD_CONFIG_DIR).replace(/\\/g, "/").toLowerCase();

    if (normalizedTarget === normalizedProd || normalizedTarget.startsWith(normalizedProd + "/")) {
      throw new Error(
        `Production target guard rejection: configDir touches protected production path '${configDir}'. Refusing to run lifecycle test against production runner.`
      );
    }
  }

  return {
    safe: true,
    port,
    configDir
  };
}
