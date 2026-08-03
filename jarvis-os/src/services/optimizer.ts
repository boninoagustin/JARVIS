// Optimizador de triggers — funciones puras, sin DOM, sin React/Firebase
// Segura para usar dentro de Web Workers

export interface TriggerGenome {
  minScore: number;           // int [4, 20]
  slBuff: number;             // float [0, 0.25]
  tp2: number;                // float [1, 4]
  partialClosePct: number;    // float [0, 0.9]
  slAfterTp1: 'midpoint' | 'breakeven' | 'none';
  tp15BeEnabled: boolean;
  atrTrailEnabled: boolean;
  structuralTrailEnabled: boolean;
  /** 🆕 ROI profiles: null=off, 0=aggro, 1=moderate */
  minimal_roi: Record<string, number> | null;
}

// --- PRNG reproducible (Mulberry32) ---
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Grid exhaustivo (mismos rangos que la fuerza bruta original) ---
const MIN_SCORE_VALS = [4, 8, 12, 16, 20];
const SL_BUFF_VALS = [0, 0.05, 0.1, 0.2];
const TP2_VALS = [1.5, 2.0, 3.0, 4.0];
const PARTIAL_CLOSE_PCT_VALS = [0, 0.5, 0.8];
const SL_AFTER_TP1_VALS: TriggerGenome['slAfterTp1'][] = ['none', 'midpoint', 'breakeven'];
const BOOL_VALS = [true, false];
const ROI_PROFILES: (Record<string, number> | null)[] = [
  null,                              // sin ROI
  {"0":0.015,"30":0.005,"60":0},    // agresivo: 1.5%→0.5%→BE
  {"0":0.01,"30":0.003,"60":0},     // moderado: 1.0%→0.3%→BE
];

export function* gridGenomes(): Generator<TriggerGenome> {
  for (const minScore of MIN_SCORE_VALS) {
    for (const slBuff of SL_BUFF_VALS) {
      for (const tp2 of TP2_VALS) {
        for (const partialClosePct of PARTIAL_CLOSE_PCT_VALS) {
          for (const slAfterTp1 of SL_AFTER_TP1_VALS) {
            for (const tp15BeEnabled of BOOL_VALS) {
              for (const atrTrailEnabled of BOOL_VALS) {
                for (const structuralTrailEnabled of BOOL_VALS) {
                  for (const minimal_roi of ROI_PROFILES) {
                    yield { minScore, slBuff, tp2, partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled, minimal_roi };
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

export function gridCount(): number {
  return MIN_SCORE_VALS.length * SL_BUFF_VALS.length * TP2_VALS.length *
    PARTIAL_CLOSE_PCT_VALS.length * SL_AFTER_TP1_VALS.length *
    BOOL_VALS.length * BOOL_VALS.length * BOOL_VALS.length * ROI_PROFILES.length;
}

// --- Helpers para GA ---
function randomGenome(rng: () => number): TriggerGenome {
  return {
    minScore: MIN_SCORE_VALS[Math.floor(rng() * MIN_SCORE_VALS.length)],
    slBuff: SL_BUFF_VALS[Math.floor(rng() * SL_BUFF_VALS.length)],
    tp2: TP2_VALS[Math.floor(rng() * TP2_VALS.length)],
    partialClosePct: PARTIAL_CLOSE_PCT_VALS[Math.floor(rng() * PARTIAL_CLOSE_PCT_VALS.length)],
    slAfterTp1: SL_AFTER_TP1_VALS[Math.floor(rng() * SL_AFTER_TP1_VALS.length)],
    tp15BeEnabled: rng() > 0.5,
    atrTrailEnabled: rng() > 0.5,
    structuralTrailEnabled: rng() > 0.5,
    minimal_roi: ROI_PROFILES[Math.floor(rng() * ROI_PROFILES.length)],
  };
}

function genomeKey(g: TriggerGenome): string {
  return `${g.minScore}|${g.slBuff}|${g.tp2}|${g.partialClosePct}|${g.slAfterTp1}|${g.tp15BeEnabled ? 1 : 0}|${g.atrTrailEnabled ? 1 : 0}|${g.structuralTrailEnabled ? 1 : 0}|${g.minimal_roi ? 'roi' : 'none'}`;
}

function crossoverUniform(a: TriggerGenome, b: TriggerGenome, rng: () => number): TriggerGenome {
  return {
    minScore: rng() > 0.5 ? a.minScore : b.minScore,
    slBuff: rng() > 0.5 ? a.slBuff : b.slBuff,
    tp2: rng() > 0.5 ? a.tp2 : b.tp2,
    partialClosePct: rng() > 0.5 ? a.partialClosePct : b.partialClosePct,
    slAfterTp1: rng() > 0.5 ? a.slAfterTp1 : b.slAfterTp1,
    tp15BeEnabled: rng() > 0.5 ? a.tp15BeEnabled : b.tp15BeEnabled,
    atrTrailEnabled: rng() > 0.5 ? a.atrTrailEnabled : b.atrTrailEnabled,
    structuralTrailEnabled: rng() > 0.5 ? a.structuralTrailEnabled : b.structuralTrailEnabled,
    minimal_roi: rng() > 0.5 ? a.minimal_roi : b.minimal_roi,
  };
}

function mutate(g: TriggerGenome, rng: () => number, rate: number): TriggerGenome {
  const m = { ...g };
  if (rng() < rate) m.minScore = MIN_SCORE_VALS[Math.floor(rng() * MIN_SCORE_VALS.length)];
  if (rng() < rate) m.slBuff = SL_BUFF_VALS[Math.floor(rng() * SL_BUFF_VALS.length)];
  if (rng() < rate) m.tp2 = TP2_VALS[Math.floor(rng() * TP2_VALS.length)];
  if (rng() < rate) m.partialClosePct = PARTIAL_CLOSE_PCT_VALS[Math.floor(rng() * PARTIAL_CLOSE_PCT_VALS.length)];
  if (rng() < rate) m.slAfterTp1 = SL_AFTER_TP1_VALS[Math.floor(rng() * SL_AFTER_TP1_VALS.length)];
  if (rng() < rate) m.tp15BeEnabled = !m.tp15BeEnabled;
  if (rng() < rate) m.atrTrailEnabled = !m.atrTrailEnabled;
  if (rng() < rate) m.structuralTrailEnabled = !m.structuralTrailEnabled;
  if (rng() < rate) m.minimal_roi = ROI_PROFILES[Math.floor(rng() * ROI_PROFILES.length)];
  return m;
}

interface GeneticConfig {
  evaluate: (g: TriggerGenome) => number;
  budget: number;
  seed?: number;
  populationSize?: number;
  maxGenerations?: number;
  elite?: number;
  tournamentK?: number;
  mutationRate?: number;
  earlyStopGens?: number;
  onProgress?: (evaluated: number, budget: number, best: TriggerGenome, bestFitness: number) => void;
}

export interface GeneticResult {
  best: TriggerGenome;
  top10: TriggerGenome[];
  evaluated: number;
}

export function geneticSearch(cfg: GeneticConfig): GeneticResult {
  const {
    evaluate, budget,
    seed = 42,
    populationSize = 24,
    maxGenerations = 20,
    elite = 2,
    tournamentK = 3,
    mutationRate = 0.15,
    earlyStopGens = 6,
    onProgress,
  } = cfg;

  const rng = mulberry32(seed);
  const memo = new Map<string, number>();
  let evalCount = 0;

  const evalMemo = (g: TriggerGenome): number => {
    const key = genomeKey(g);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (evalCount >= budget) return -Infinity;
    const fitness = evaluate(g);
    memo.set(key, fitness);
    evalCount++;
    return fitness;
  };

  // Init population
  let population: TriggerGenome[] = [];
  for (let i = 0; i < populationSize; i++) {
    population.push(randomGenome(rng));
  }

  let bestFitness = -Infinity;
  let bestGenome = population[0];
  let gensWithoutImprovement = 0;

  for (let gen = 0; gen < maxGenerations; gen++) {
    if (evalCount >= budget) break;

    // Evaluate
    const scored = population.map(g => ({ genome: g, fitness: evalMemo(g) }));
    scored.sort((a, b) => b.fitness - a.fitness);

    const currentBest = scored[0];
    if (currentBest.fitness > bestFitness + 0.01) {
      bestFitness = currentBest.fitness;
      bestGenome = { ...currentBest.genome };
      gensWithoutImprovement = 0;
    } else {
      gensWithoutImprovement++;
    }

    onProgress?.(evalCount, budget, bestGenome, bestFitness);

    if (gensWithoutImprovement >= earlyStopGens && gen >= 4) break;
    if (evalCount >= budget) break;

    // Elitism
    const nextGen: TriggerGenome[] = [];
    for (let i = 0; i < elite && i < scored.length; i++) {
      nextGen.push({ ...scored[i].genome });
    }

    // Fill rest with tournament + crossover + mutation
    while (nextGen.length < populationSize) {
      // Tournament selection
      const tournament = (): TriggerGenome => {
        let best: { genome: TriggerGenome; fitness: number } | null = null;
        for (let i = 0; i < tournamentK; i++) {
          const idx = Math.floor(rng() * scored.length);
          const candidate = scored[idx];
          if (!best || candidate.fitness > best.fitness) best = candidate;
        }
        return best!.genome;
      };

      const parent1 = tournament();
      const parent2 = tournament();

      let child = crossoverUniform(parent1, parent2, rng);
      child = mutate(child, rng, mutationRate);
      nextGen.push(child);
    }

    population = nextGen;
  }

  // Final sort and top 10
  const finalScored = population.map(g => ({ genome: g, fitness: evalMemo(g) }));
  finalScored.sort((a, b) => b.fitness - a.fitness);

  return {
    best: finalScored[0].genome,
    top10: finalScored.slice(0, 10).map(s => s.genome),
    evaluated: evalCount,
  };
}
