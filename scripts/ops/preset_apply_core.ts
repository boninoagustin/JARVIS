/**
 * H04 (auditoría 2026-11-05): aplicación ATÓMICA y con CAS del preset de detección.
 *
 * - Lock de aplicación con `openSync(..., 'wx')` (O_EXCL atómico; NO existe flock en node:fs).
 *   Lock viejo (>2 h) se considera huérfano y se retira.
 * - CAS: si el preset cambió desde el inicio de la evaluación, aborta sin escribir.
 * - Backup versionado (`.bak-<ts>`) ANTES de escribir; tmp + rename atómico; readback JSON.
 *
 * Puro respecto del bot: no importa nada del engine, se testea con archivos temporales.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function jsonSha(obj: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

export function fileSha(p: string): string {
    return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '';
}

export type ApplyResult =
    | { ok: true; backup: string | null; sha: string }
    | { ok: false; code: 'LOCKED' | 'CHANGED' | 'WRITE_FAILED'; message: string };

export function applyPresetAtomic(opts: {
    presetPath: string;
    expectedSha?: string;
    lockPath?: string;
    staleLockMs?: number;
    build: (current: any) => any;
}): ApplyResult {
    const lockPath = opts.lockPath ?? `/tmp/detection_apply_${path.basename(opts.presetPath)}.lock`;
    const staleMs = opts.staleLockMs ?? 2 * 3600_000;

    // Lock O_EXCL (atómico). Un lock huérfano viejo se retira una vez.
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
            acquired = true;
        } catch (e: any) {
            if (e?.code !== 'EEXIST') return { ok: false, code: 'LOCKED', message: `no se pudo tomar el lock: ${e?.message ?? e}` };
            let stale = false;
            try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs; } catch { /* ya se fue */ }
            if (!stale) return { ok: false, code: 'LOCKED', message: 'otro apply en curso' };
            try { fs.unlinkSync(lockPath); } catch { /* noop */ }
        }
    }
    if (!acquired) return { ok: false, code: 'LOCKED', message: 'no se pudo tomar el lock' };

    try {
        // expectedSha === '' significa "el preset NO existía al evaluar": si alguien lo creó
        // durante la búsqueda, también es un cambio y se aborta (caso presets nuevos).
        if (opts.expectedSha !== undefined && fileSha(opts.presetPath) !== opts.expectedSha) {
            return { ok: false, code: 'CHANGED', message: 'el preset cambió desde la evaluación' };
        }
        const current = fs.existsSync(opts.presetPath) ? JSON.parse(fs.readFileSync(opts.presetPath, 'utf8')) : {};
        const next = opts.build(current);

        let backup: string | null = null;
        if (fs.existsSync(opts.presetPath)) {
            backup = `${opts.presetPath}.bak-${Date.now()}`;
            fs.copyFileSync(opts.presetPath, backup);
        }
        const tmp = `${opts.presetPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, opts.presetPath);      // atómico
        JSON.parse(fs.readFileSync(opts.presetPath, 'utf8'));   // readback
        return { ok: true, backup, sha: fileSha(opts.presetPath) };
    } catch (e: any) {
        try { fs.unlinkSync(`${opts.presetPath}.tmp`); } catch { /* noop */ }
        return { ok: false, code: 'WRITE_FAILED', message: String(e?.message ?? e) };
    } finally {
        try { fs.unlinkSync(lockPath); } catch { /* noop */ }
    }
}
