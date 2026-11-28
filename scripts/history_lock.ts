import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function resolveHistoryLockPath(ticker: string): string {
    const clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, '');
    if (!clean) throw new Error(`Invalid ticker for history lock: ${ticker}`);
    const lockDir = process.env.JARVIS_HISTORY_LOCK_DIR || '/var/lock';
    fs.mkdirSync(lockDir, { recursive: true });
    return path.join(lockDir, `jarvis_history_${clean}.lock`);
}

/**
 * Kernel advisory flock(2) shared across TypeScript, Python and Bash via Python's fcntl.flock.
 * Automatically released by the kernel if the holder process dies.
 */
export async function withTickerHistoryLock<T>(
    ticker: string,
    fn: () => Promise<T> | T,
    options: { timeoutSec?: number; shared?: boolean } = {},
): Promise<T> {
    const lockPath = resolveHistoryLockPath(ticker);
    const timeoutSec = options.timeoutSec ?? 300;
    const mode = options.shared ? 'SH' : 'EX';
    const pyCode = [
        'import fcntl, os, sys, time',
        'path, mode, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])',
        'fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)',
        'op = fcntl.LOCK_SH if mode == "SH" else fcntl.LOCK_EX',
        'deadline = time.monotonic() + timeout',
        'while True:',
        '    try:',
        '        fcntl.flock(fd, op | fcntl.LOCK_NB)',
        '        break',
        '    except BlockingIOError:',
        '        if time.monotonic() >= deadline:',
        '            sys.stderr.write(f"lock timeout ({timeout}s) on {path}\\n")',
        '            sys.exit(75)',
        '        time.sleep(0.1)',
        'sys.stdout.write("LOCKED\\n")',
        'sys.stdout.flush()',
        'sys.stdin.read()',
    ].join('\n');

    const holder = spawn('python3', ['-c', pyCode, lockPath, mode, String(timeoutSec)], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolve, reject) => {
        let stderr = '';
        let settled = false;
        holder.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        holder.stdout.on('data', (d: Buffer) => {
            if (!settled && d.toString().includes('LOCKED')) {
                settled = true;
                resolve();
            }
        });
        holder.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });
        holder.on('exit', (code) => {
            if (!settled) {
                settled = true;
                reject(new Error(`Failed to acquire history lock ${lockPath} (exit ${code}): ${stderr.trim()}`));
            }
        });
    });

    try {
        return await fn();
    } finally {
        try { holder.stdin.end(); } catch {}
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                try { holder.kill('SIGKILL'); } catch {}
                resolve();
            }, 2000);
            holder.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

export function atomicWriteFileSync(targetPath: string, content: string | Buffer, mode = 0o644): void {
    const dir = path.dirname(path.resolve(targetPath));
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    let fd: number | null = null;
    try {
        fd = fs.openSync(tmpPath, 'wx', mode);
        if (typeof content === 'string') {
            fs.writeSync(fd, content, undefined, 'utf8');
        } else {
            fs.writeSync(fd, content);
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, targetPath);
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch {}
        }
        if (fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch {}
        }
    }
}
