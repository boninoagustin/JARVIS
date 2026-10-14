/**
 * tf_sweep_weekly.ts — AUTOMATIZACIÓN SEMANAL DE BLOQUES TF (22-sep-2026, decisión de Bon).
 *
 * Flujo: lee el diagnóstico (detection_diagnostics/latest) → corre smc_tf_sweep.ts
 * (--fast) SOLO para los activos flaggeados (máx --max, prioridad por score) →
 * para cada propuesta RECOMMEND aplica los bloques al preset raíz con snapshot →
 * si hubo aplicaciones, reinicia el bot (pm2) para que el motor vivo cargue los bloques.
 *
 * Se corre como paso post del ciclo semanal (sábado, mercado cerrado → reinicio seguro).
 * Un ciclo de demora en el mundo hyperopt: los pine-logs del próximo refresh ya saldrán
 * con los bloques nuevos; este ciclo corrió con los viejos.
 *
 * Uso: npx tsx scripts/periodic_opt/tf_sweep_weekly.ts [--max 3] [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'service-account.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// Acepta --max=N y --max N (el service usa la forma con espacio)
const maxIdx = process.argv.indexOf('--max');
const MAX = maxIdx !== -1
  ? Number(process.argv[maxIdx + 1] || process.argv.find(a => a.startsWith('--max='))?.split('=')[1] || 3)
  : 3;
const DRY = process.argv.includes('--dry-run');
const NPX = '/root/.nvm/versions/node/v24.19.0/bin/npx';
const PRESET_TF: Record<string, string> = { '15': 'M15', '60': 'H1', '240': 'H4', 'D': 'D1' };

function applyProposal(ticker: string, prop: any): string {
  const presetPath = path.join(REPO, `optimized_preset_${ticker}.json`);
  const blocks: any = {};
  for (const [tf, tfKey] of Object.entries(PRESET_TF)) {
    if (prop.proposal.blocks[tf]) blocks[tfKey] = prop.proposal.blocks[tf];
  }
  const prev = fs.existsSync(presetPath) ? JSON.parse(fs.readFileSync(presetPath, 'utf8')) : {};
  const snapPath = path.join(REPO, 'backups', `preset_prev_${ticker}_${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(snapPath, JSON.stringify(prev, null, 2));
  const out = {
    ...prev,
    ...blocks,
    Meta: {
      ...(prev.Meta || {}),
      tfSource: 'tf_sweep_weekly', tfVerdict: prop.verdict,
      tfAppliedAt: new Date().toISOString(),
      tfBaselineExp: prop.baseline.metrics.exp, tfProposalExp: prop.proposal.metrics.exp,
    },
  };
  fs.writeFileSync(presetPath, JSON.stringify(out, null, 2));
  return snapPath;
}

async function main() {
  const snap = await db.collection('detection_diagnostics').doc('latest').get();
  const flags: any[] = (snap.data() || {}).flags || [];
  if (flags.length === 0) { console.log('✅ diagnóstico sin flags — no hay sweeps TF esta semana'); process.exit(0); }
  const targets = flags.slice(0, MAX).map((f: any) => ({ ticker: f.ticker, score: f.score }));
  console.log(`🩺 ${flags.length} flaggeados → sweep a ${targets.length} (${targets.map(t => t.ticker).join(', ')})`);

  const applied: string[] = [];
  for (const t of targets) {
    console.log(`\n═══════ TF SWEEP ${t.ticker} (score=${t.score}) ═══════`);
    // 🛡️ Snapshot del preset ANTES del spawn: si el sweep muere a mitad (timeout/kill),
    // el preset queda con una variante a medio probar → restaurar SIEMPRE tras el spawn.
    const presetPath = path.join(REPO, `optimized_preset_${t.ticker}.json`);
    const presetBefore = fs.existsSync(presetPath) ? fs.readFileSync(presetPath, 'utf8') : null;
    try {
      const r = spawnSync(NPX, ['tsx', path.join(REPO, 'scripts/periodic_opt/smc_tf_sweep.ts'), t.ticker, '--fast'],
        { cwd: REPO, stdio: 'inherit', timeout: 2 * 60 * 60 * 1000, env: { ...process.env, PATH: '/root/.nvm/versions/node/v24.19.0/bin:' + process.env.PATH } });
      // Restaurar el preset pre-spawn pase lo que pase (el sweep exitoso ya lo restauró; un kill no)
      if (presetBefore !== null) {
        try { fs.writeFileSync(presetPath, presetBefore); } catch {}
      }
      if (r.status !== 0) { console.log(`⚠️ ${t.ticker}: sweep exit=${r.status} — se saltea`); continue; }
      const propPath = path.join(REPO, `optimized_preset_${t.ticker}_tfproposal.json`);
      if (!fs.existsSync(propPath)) { console.log(`⚠️ ${t.ticker}: sin proposal — se saltea`); continue; }
      const prop = JSON.parse(fs.readFileSync(propPath, 'utf8'));
      console.log(`  → ${prop.verdict}: exp ${prop.baseline.metrics.exp.toFixed(3)} → ${prop.proposal.metrics.exp.toFixed(3)}R/t (trades=${prop.proposal.metrics.trades})`);
      if (prop.verdict !== 'RECOMMEND') continue;
      if (DRY) { console.log(`  [DRY] se aplicaría (snapshot + preset)`); applied.push(`${t.ticker} (dry)`); continue; }
      const snapPath = applyProposal(t.ticker, prop);
      applied.push(`${t.ticker} (prev → ${path.basename(snapPath)})`);
      console.log(`  ✅ APLICADO al preset raíz`);
    } catch (e: any) {
      console.log(`⚠️ ${t.ticker}: error (${e?.message}) — se saltea`);
    }
  }

  if (applied.length > 0 && !DRY) {
    console.log(`\n♻️ ${applied.length} presets aplicados → reiniciando bot (pm2 JARVIS) para cargar bloques…`);
    execFileSync('bash', ['-c', `export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH" && pm2 restart JARVIS --update-env >/dev/null 2>&1 && echo OK`], { stdio: 'inherit' });
    console.log('  bot reiniciado — bloques TF nuevos en vivo');
  } else {
    console.log('\nSin RECOMMENDs para aplicar esta semana.');
  }
  console.log(`\n🏁 tf_sweep_weekly completo: ${applied.join(', ') || 'nada aplicado'}`);
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
