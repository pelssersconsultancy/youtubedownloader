import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'node:readline';

export interface YtdlpRunOptions {
  /** Kill the process after this many milliseconds. */
  timeout?: number;
  /** Maximum stderr bytes to retain (default 8 000). */
  stderrLimit?: number;
  /** Called for each stdout line. When provided, stdout is not buffered in the result. */
  onLine?: (line: string) => void;
  /** Called with each integer progress percentage parsed from stdout. */
  onProgress?: (pct: number) => void;
}

export interface YtdlpRunResult {
  ok: boolean;
  /** Buffered stdout. Empty when onLine was provided. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface YtdlpErrorClassification {
  retryable: boolean;
  permanent: boolean;
  errorClass: string;
}

@Injectable()
export class YtdlpRunner implements OnModuleDestroy {
  readonly path = process.env.YTDLP_PATH ?? 'yt-dlp';
  private readonly processes = new Set<ChildProcess>();

  run(args: string[], opts: YtdlpRunOptions = {}): { result: Promise<YtdlpRunResult>; kill: (signal?: NodeJS.Signals) => void } {
    const { timeout, stderrLimit = 8_000, onLine, onProgress } = opts;
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const p = spawn(this.path, ['--js-runtimes', 'node', ...args]);
    this.processes.add(p);

    if (onLine) {
      const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
      rl.on('line', onLine);
      p.on('close', () => rl.close());
    } else {
      p.stdout.on('data', (chunk: Buffer) => {
        const str = String(chunk);
        stdout += str;
        if (onProgress) {
          const m = /(\d+(?:\.\d+)?)%/.exec(str);
          if (m) onProgress(Math.round(parseFloat(m[1])));
        }
      });
    }

    p.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`;
      if (stderr.length > stderrLimit) stderr = stderr.slice(-stderrLimit);
    });

    if (timeout) {
      timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeout);
      timer.unref?.();
    }

    const kill = (signal: NodeJS.Signals = 'SIGTERM') => { p.kill(signal); };

    const result = new Promise<YtdlpRunResult>((resolve) => {
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.processes.delete(p);
        resolve({ ok, stdout, stderr, timedOut });
      };
      p.on('error', () => finish(false));
      p.on('close', (code) => finish(code === 0));
    });

    return { result, kill };
  }

  killAll(signal: NodeJS.Signals = 'SIGTERM') {
    for (const p of this.processes) p.kill(signal);
  }

  onModuleDestroy() {
    this.killAll();
  }

  classifyError(error: string): YtdlpErrorClassification {
    if (/HTTP Error 429|Too Many Requests|rate-limited by YouTube|rate limit/i.test(error)) {
      return { retryable: true, permanent: false, errorClass: 'rate_limited' };
    }
    if (/members.only|subscriber.only|private video|has been removed|video has been removed|this video is not available|video unavailable|no longer available|not available in your country|account has been terminated|channel has been terminated/i.test(error)) {
      return { retryable: false, permanent: true, errorClass: 'access_unavailable' };
    }
    if (/HTTP Error 403|Forbidden/i.test(error)) {
      return { retryable: true, permanent: false, errorClass: 'access_denied_temporary' };
    }
    if (/timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|connection (?:reset|closed|refused)|HTTP Error 5\d\d|temporarily unavailable|TLS/i.test(error)) {
      return { retryable: true, permanent: false, errorClass: 'transient_network' };
    }
    return { retryable: false, permanent: false, errorClass: 'non_retryable' };
  }
}
