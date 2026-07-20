import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { settings } from "@oh-my-pi/pi-coding-agent";
import { type BashOperations } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

import { type SandboxConfig } from "./config.ts";
import { domainIsAllowed } from "./policy.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

export function createNetworkAskCallback(allowedDomains: string[]): SandboxAskCallback {
  return async ({ host }) => domainIsAllowed(host, allowedDomains);
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): SandboxRuntimeConfig {
  return {
    network: {
      ...config.network,
      allowedDomains: [...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])],
      deniedDomains: config.network?.deniedDomains ?? [],
    },
    filesystem: {
      ...config.filesystem,
      denyRead: config.filesystem?.denyRead ?? [],
      allowRead: [...(config.filesystem?.allowRead ?? []), ...(allowances?.readPaths ?? [])],
      allowWrite: [...(config.filesystem?.allowWrite ?? []), ...(allowances?.writePaths ?? [])],
      denyWrite: config.filesystem?.denyWrite ?? [],
    },
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: true,
  };
}

export async function initializeSandbox(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
  await SandboxManager.initialize(
    runtimeConfig,
    createNetworkAskCallback(runtimeConfig.network?.allowedDomains ?? []),
  );
}

export async function reinitializeSandbox(
  config: SandboxConfig,
  allowances: SessionAllowances,
): Promise<void> {
  await SandboxManager.reset();
  await initializeSandbox(config, allowances);
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): Operation not permitted/,
  );
  return match ? match[1] : null;
}

export function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      const { shell, args } = settings.getShellConfig();
      const wrappedCommand = await SandboxManager.wrapWithSandbox(command, shell);

      return new Promise((resolve, reject) => {
        const child = spawn(shell, [...args, wrappedCommand], {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const killProcessGroup = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessGroup();
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(error);
        });

        signal?.addEventListener("abort", killProcessGroup, { once: true });
        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", killProcessGroup);
          SandboxManager.cleanupAfterCommand();

          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}

export interface UserBashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timedOut?: boolean;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export async function runSandboxedUserBash(command: string, cwd: string): Promise<UserBashResult> {
  const chunks: Buffer[] = [];
  const ops = createSandboxedBashOps();
  let cancelled = false;
  let timedOut = false;
  let exitCode: number | undefined;
  try {
    const result = await ops.exec(command, cwd, {
      onData: (data) => chunks.push(Buffer.from(data)),
      env: settings.getShellConfig().env,
    });
    exitCode = result.exitCode ?? undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "aborted") cancelled = true;
    else if (message.startsWith("timeout:")) timedOut = true;
    else throw error;
    exitCode = undefined;
  }
  const output = Buffer.concat(chunks).toString("utf-8");
  const totalBytes = Buffer.byteLength(output, "utf-8");
  const totalLines = output.length === 0 ? 0 : output.split("\n").length;
  return {
    output,
    exitCode,
    cancelled,
    timedOut,
    truncated: false,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
  };
}
