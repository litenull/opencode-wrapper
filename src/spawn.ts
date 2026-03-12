import { spawn as nodeSpawn, ChildProcess } from "child_process";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawn(args: string[], capture: false): Promise<number>;
export function spawn(args: string[], capture: true): Promise<SpawnResult>;
export function spawn(args: string[], capture: boolean): Promise<number | SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = nodeSpawn(args[0], args.slice(1));

    let stdout = "";
    let stderr = "";

    if (proc.stdout) {
      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    }

    proc.on("error", (err: Error) => {
      reject(err);
    });

    proc.on("close", (code: number | null) => {
      const exitCode = code ?? 1;
      if (capture) {
        resolve({ code: exitCode, stdout, stderr });
      } else {
        resolve(exitCode);
      }
    });
  });
}
