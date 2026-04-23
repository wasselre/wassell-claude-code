import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

// 7-day retention: any file older than this (by mtime) is swept on boot.
// Covers a weekend of debugging without bloating the log dir.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Returns a YYYY-MM-DD stamp for today, used as the log file suffix. */
function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Mirror of `console.log` signature — any printable args. */
type LogArgs = readonly unknown[];

let stream: WriteStream | null = null;

function formatLine(level: 'log' | 'warn' | 'error', args: LogArgs): string {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  return `${ts} [${level}] ${body}\n`;
}

/** Sweep log files older than RETENTION_MS from dir. Swallows all errors — this
 *  is housekeeping, not critical path. */
function sweepOldLogs(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('daemon-') || !name.endsWith('.log')) continue;
    const full = join(dir, name);
    try {
      const age = now - statSync(full).mtimeMs;
      if (age > RETENTION_MS) unlinkSync(full);
    } catch {
      // file vanished between readdir and stat, or permission denied — skip.
    }
  }
}

/**
 * Tee `console.log` / `console.warn` / `console.error` to a dated file under
 * `logDir`. Stdout stays the way it was (noop wrap) so `npm start` still
 * shows live output. One call is enough for the process lifetime; subsequent
 * calls are no-ops.
 *
 * File rotation is day-based: each UTC day gets its own file. Files older
 * than 7 days are deleted on startup.
 */
export function installFileLogger(logDir: string): void {
  if (stream) return; // already installed
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (err) {
    // If we can't even create the log dir, don't crash the daemon — just log
    // once to stderr and give up on file logging. The user can set LOG_DIR
    // to somewhere writable.
    process.stderr.write(
      `[logger] could not create log dir ${logDir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  sweepOldLogs(logDir);

  const filePath = join(logDir, `daemon-${todayStamp()}.log`);
  stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: LogArgs) => {
    origLog(...args);
    stream?.write(formatLine('log', args));
  };
  console.warn = (...args: LogArgs) => {
    origWarn(...args);
    stream?.write(formatLine('warn', args));
  };
  console.error = (...args: LogArgs) => {
    origError(...args);
    stream?.write(formatLine('error', args));
  };

  // Best-effort flush on exit. The stream's default destroy path handles
  // the actual write; we just need to keep the handler registered.
  process.on('exit', () => {
    stream?.end();
  });

  origLog(`[logger] writing to ${filePath} (7-day retention)`);
}
