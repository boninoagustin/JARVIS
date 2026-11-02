import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import type { OHLCV, SMCPreset, OrderBlock } from './src/engine/smc/types.js';
// Guards installed before importing the real, pure engine graph. No services.
const deny = () => { throw new Error('NETWORK_FORBIDDEN'); };
net.Socket.prototype.connect = deny as any;
tls.connect = deny as any;
dgram.createSocket = deny as any;
globalThis.fetch = deny as any;
const { SMCEngine } = await import('./src/engine/smc/SMCEngine.js');
const { getPreset, loadOptimizedPreset } = await import('./src/engine/smc/smc_config.js');
const { ImbalanceEngine } = await import('./src/engine/smc/modules/imbalances.js');
const { OrderBlockEngine, hasActiveAdjacentFVG } = await import('./src/engine/smc/modules/order_blocks.js');
const BASE = 1_700_000_000_000, STEP = 3_600_000;
const log = console.log.bind(console);
console.log = () => {};
const mode = process.argv[2] ?? 'all';
let count = 0, failures = 0;
function test(group: string, name: string, f: () => void) {
    if (mode !== 'all' && mode !== group) return;
    count++;
    try { f(); log(`PASS ${name}`); }
    catch (e) { failures++; log(`FAIL ${name}: ${e instanceof Error ? e.stack : e}`); }
}
const bar = (i: number, o: number, h: number, l: number, c: number): OHLCV => ({ timestamp: BASE + i * STEP, open: o, high: h, low: l, close: c, volume: 10 });
const mirror = (c: OHLCV): OHLCV => ({ ...c, open: 220-c.open, high: 220-c.low, low: 220-c.high, close: 220-c.close });
function fixture(kind: 'crt' | 'coiled', enabled: boolean, sell: boolean, period = 'H1', extra: Partial<SMCPreset> = {}) {
    const preset: SMCPreset = { ...getPreset('Forex - 3. Balanceado'), pivot_len: 3, valid_bos_displacement: false,
        choch_require_sweep: false, choch_require_momentum: false, ...extra };
    const engine = new SMCEngine(preset, period);
    const bars = Array.from({length:18}, (_,i) => bar(i,110,111,109,110.2));
    if (kind === 'crt') bars.push(bar(18,99,103,97,enabled ? 101 : 99.5), bar(19,99,101,96,98), bar(20,98,101,97,100), bar(21,100,106,100,105));
    else bars.push(bar(18,101,104,96,99), bar(19,enabled ? 100 : 105,106,97,100), bar(20,99,102,98,100), bar(21,99,102,98,100), bar(22,100,108,99,107));
    const input = sell ? bars.map(mirror) : bars;
    for (const c of input.slice(0,-1)) engine.nextCandle(c);
    // Seed only a public-state pivot. All calculators, liquidity, market structure,
    // FVG lifecycle, OB selection, caller context and scoring execute unmodified.
    const state = engine.getState();
    const price = kind === 'crt' ? 104 : 106;
    const pivots = sell ? state.pivotsLow : state.pivotsHigh;
    pivots.push({ index:18, timestamp: input[18].timestamp, price: sell ? 220-price : price, type: sell ? 'Low' : 'High', isBroken:false });
    return { engine, input, preset, run: () => engine.nextCandle(input.at(-1)!) };
}
function structural(events: any[]): { ev: any; ob: OrderBlock } {
    const ev = events.find(e => e.type === 'EVENT_BOS' || e.type === 'EVENT_CHOCH');
    assert.ok(ev, 'positive control: native structural event');
    const obs = events.filter(e => e.type === 'EVENT_OB_CREATED' && e.ob.category !== 'Legacy');
    assert.equal(obs.length,1,'positive control: native structural OB');
    assert.equal(obs[0].ob.direction,ev.direction);
    return {ev,ob:obs[0].ob};
}
for (const sell of [false,true]) {
    const side = sell ? 'SELL' : 'BUY';
    test('crt', `${side}: real CRT event adds exactly its existing +2 to its OB`, () => {
        const yes = structural(fixture('crt',true,sell).run());
        const no = structural(fixture('crt',false,sell).run());
        assert.equal(yes.ev.crtOrigin,true); assert.equal(no.ev.crtOrigin,false);
        assert.equal(yes.ev.isCoiled,false); assert.equal(no.ev.isCoiled,false);
        assert.equal(yes.ob.timestamp,no.ob.timestamp); assert.equal(yes.ob.top,no.ob.top); assert.equal(yes.ob.bottom,no.ob.bottom);
        assert.ok(no.ob.score < 8,'avoid score cap masking a bonus');
        assert.equal(yes.ob.score,no.ob.score+2,'CRT metadata lost between native event and real structural OB');
    });
    test('coiled', `${side}: real coiled event adds exactly its existing +3 to its OB`, () => {
        const yes = structural(fixture('coiled',true,sell).run());
        const no = structural(fixture('coiled',false,sell).run());
        assert.equal(yes.ev.isCoiled,true); assert.equal(no.ev.isCoiled,false);
        assert.equal(yes.ev.crtOrigin,false); assert.equal(no.ev.crtOrigin,false);
        assert.equal(yes.ob.timestamp,no.ob.timestamp); assert.equal(yes.ob.top,no.ob.top); assert.equal(yes.ob.bottom,no.ob.bottom);
        assert.ok(no.ob.score < 7,'avoid score cap masking a bonus');
        assert.equal(yes.ob.score,no.ob.score+3,'coiled metadata lost between native event and real structural OB');
    });
    test('htf', `${side}: caller HTF callback honors weekly only on native HTFs`, () => {
        const aligned = sell ? 'Bearish' : 'Bullish';
        const opposite = sell ? 'Bullish' : 'Bearish';
        for (const period of ['H1','H4','D1','W1','M15']) {
            const neutral = fixture('crt',false,sell,period);
            const weekly = fixture('crt',false,sell,period);
            const wrong = fixture('crt',false,sell,period);
            const htf = fixture('crt',false,sell,period);
            neutral.engine.setHTFContext('Neutral','Neutral');
            weekly.engine.setHTFContext('Neutral',aligned);
            wrong.engine.setHTFContext('Neutral',opposite);
            htf.engine.setHTFContext(aligned,opposite);
            const base = structural(neutral.run()).ob.score;
            assert.equal(structural(wrong.run()).ob.score,base);
            assert.equal(structural(htf.run()).ob.score,base+2);
            assert.equal(structural(weekly.run()).ob.score,base+(period === 'M15' ? 0 : 2),`${period}: computed callback was ignored`);
        }
    });
}
test('htf', 'older direct callers retain trend fallback; callback false overrides matching trend', () => {
    for (const sell of [false,true]) {
        const direction = sell ? 'Bearish' : 'Bullish';
        const calc = (context: any) => {
            const f = fixture('crt',false,sell);
            f.engine.orderBlocks.updateHistory(f.input.at(-1)!);
            return f.engine.orderBlocks.createStructuralOB({type:'EVENT_CHOCH',direction},1,f.preset,context)[0].score;
        };
        const base = calc({});
        assert.equal(calc({htfTrend:direction}),base+2);
        assert.equal(calc({htfAligned:() => true}),base+2);
        assert.equal(calc({htfTrend:direction,htfAligned:() => false}),base,'callback false must not fall through to trend');
    }
});
function fvgFixture(sell: boolean, kind = 'near', extra: Partial<SMCPreset> = {}) {
    const preset: SMCPreset = {...getPreset('Forex - 3. Balanceado'), pivot_len:3, use_body_for_ob:false,
        fvg_min_atr_factor: kind === 'none' ? 100 : .1, valid_bos_displacement:false, choch_require_sweep:false, choch_require_momentum:false, ...extra};
    const engine = new SMCEngine(preset,'H1');
    const bars = Array.from({length:18},(_,i) => bar(i,110,111,109,110.2));
    bars.push(bar(18,101,101,96,99),bar(19,99,106,98,105),bar(20,103,106,102,105),bar(21,105,109,103,108));
    const input = sell ? bars.map(mirror) : bars;
    for (const b of input.slice(0,-1)) engine.nextCandle(b);
    const state = engine.getState();
    const fvg = state.activeFVGs.find(f => f.timestamp === input[19].timestamp && f.direction === (sell ? 'Bearish':'Bullish'));
    if (kind !== 'none') {
        assert.ok(fvg,'positive control: real ImbalanceEngine emitted adjacent FVG');
        assert.equal(fvg.mitigated,false); assert.equal(fvg.is_ifvg,false);
        if (kind === 'far') {
            const shift = sell ? 30 : -30;
            fvg.top += shift; fvg.bottom += shift; fvg.originalTop! += shift; fvg.originalBottom! += shift;
        } else if (kind === 'future') fvg.availableAt = input[21].timestamp+STEP;
        else if (kind === 'invalid') fvg.availableAt = NaN;
        else if (kind === 'mitigated') fvg.mitigated = true;
        else if (kind === 'old') fvg.timestamp = input[0].timestamp;
        else if (kind === 'removed') state.activeFVGs.splice(state.activeFVGs.indexOf(fvg),1);
    }
    (sell ? state.pivotsLow : state.pivotsHigh).push({ index:18,timestamp:input[18].timestamp,price:sell ? 113:107,type:sell?'Low':'High',isBroken:false });
    return {engine,input,preset,run:() => engine.nextCandle(input.at(-1)!)};
}
for (const sell of [false,true]) test('fvg', `${sell ? 'SELL':'BUY'}: only causal active OB-adjacent FVG earns the existing +1`, () => {
    const baseline = structural(fvgFixture(sell,'none').run()).ob;
    for (const kind of ['far','future','invalid','mitigated','old','removed']) {
        const ob = structural(fvgFixture(sell,kind).run()).ob;
        assert.equal(ob.timestamp,baseline.timestamp); assert.equal(ob.top,baseline.top); assert.equal(ob.bottom,baseline.bottom);
        assert.equal(ob.score,baseline.score,`${kind} is not an adjacent available active FVG`);
    }
    const near = structural(fvgFixture(sell).run()).ob;
    assert.equal(near.timestamp,baseline.timestamp); assert.equal(near.top,baseline.top); assert.equal(near.bottom,baseline.bottom);
    assert.equal(near.score,baseline.score+1,'real adjacent active FVG never reached structural score');
});
function loaded(detection: Record<string,unknown> = {}, tf: Record<string,unknown> = {}): SMCPreset {
    const root = path.resolve(process.env.ZONES_EVIDENCE_DIR ?? 'evidence');
    fs.mkdirSync(root,{recursive:true});
    const dir = fs.mkdtempSync(path.join(root,'presets-'));
    const file = path.join(dir,'fixture.json');
    fs.writeFileSync(file,JSON.stringify({H1:tf,Detection:detection},null,2));
    return loadOptimizedPreset('OFFLINE','H1','Forex - 3. Balanceado',{presetFile:file});
}
for (const sell of [false,true]) {
    const side = sell ? 'SELL':'BUY';
    test('alias', `${side}: loaded Detection threshold drives real legacy ImbalanceEngine`, () => {
        const detect = (preset: SMCPreset, gap: number) => {
            const input = [bar(0,9,10,8,9),bar(1,9,14,9,13),bar(2,10+gap,14,10+gap,13)];
            const e = new ImbalanceEngine();
            let events: any[] = [];
            for (const b of sell ? input.map(mirror) : input) events = e.processCandle(b,2,preset,STEP);
            return events.filter(e => e.type === 'EVENT_FVG_CREATED');
        };
        const low = loaded({fvg_min_atr:.1});
        const high = loaded({fvg_min_atr:.8});
        assert.equal(detect(high,1.2).length,0,'loaded high threshold must suppress a default-accepted gap');
        assert.equal(detect(low,.6).length,1,'loaded low threshold must accept a default-rejected gap');
        assert.equal(detect(low,.6)[0].fvg.direction,sell?'Bearish':'Bullish');
        assert.equal(low.fvg_min_atr,.1,'OB gate alias retained');
        assert.equal(low.fvg_min_atr_factor,.1,'legacy detector alias filled');
        const absent = loaded();
        assert.equal(absent.fvg_min_atr,undefined); assert.equal(absent.fvg_min_atr_factor,undefined);
        assert.equal(detect(absent,.999).length,0); assert.equal(detect(absent,1).length,1,'absent preserves exact >= ATR*.5 default');
        assert.equal(detect(loaded({fvg_min_atr:0}),.01).length,1,'explicit zero is not absent');
    });
    test('alias', `${side}: loaded preset traverses real SMCEngine FVG caller`, () => {
        const low = fvgFixture(sell,'none',loaded({fvg_min_atr:.1}));
        const high = fvgFixture(sell,'none',loaded({fvg_min_atr:1}));
        const direction = sell ? 'Bearish':'Bullish';
        const target = low.input[19].timestamp;
        assert.equal(high.engine.getState().activeFVGs.some(f => f.timestamp === target && f.direction === direction),false,'loaded high threshold at actual engine caller');
        assert.equal(low.engine.getState().activeFVGs.some(f => f.timestamp === target && f.direction === direction),true,'loaded low threshold at actual engine caller');
        assert.ok(structural(low.run()).ob); assert.ok(structural(high.run()).ob);
    });
    test('alias', `${side}: require_fvg_after_ob still consumes loaded fvg_min_atr`, () => {
        const count = (threshold: number) => {
            const preset = loaded({require_fvg_after_ob:true,fvg_min_atr:threshold});
            const e = new OrderBlockEngine();
            const input = [bar(0,9,10,8.5,9),bar(1,9,10,8.5,9),bar(2,10,10,8,9),bar(3,9,14,9,13),bar(4,11,14,11,13)];
            for (const b of sell ? input.map(mirror) : input) e.updateHistory(b);
            return e.createStructuralOB({type:'EVENT_CHOCH',direction:sell?'Bearish':'Bullish'},2,preset).length;
        };
        assert.equal(count(.8),0); assert.equal(count(.1),1);
        assert.equal(count(.5),0,'gate strict > boundary preserved, unlike detector >=' );
    });
}
test('alias','Detection priority over TF and inert/default preset fields stay unchanged', () => {
    const p = loaded({pivot_len:7,z_score_window:99,strict_sweep:true,fvg_min_atr:.2},{pivot_len:4,z_window:22});
    assert.equal(p.pivot_len,7); assert.equal(p.z_score_window,99); assert.equal(p.strict_sweep,true);
    assert.deepEqual(getPreset('Forex - 3. Balanceado'),{name:'Forex - 3. Balanceado',risk_level:3,asset_type:'forex',override_choch:true,require_displacement:true,require_fvg_after_ob:false,strict_breaker:true,strict_sweep:false,confirm_close:true,min_score:3});
});
for (const sell of [false,true]) {
    const side = sell ? 'SELL':'BUY';
    test('fvg', `${side}: pure adjacency helper rejects direction, iFVG, invalid and unavailable geometry`, () => {
        const f = fvgFixture(sell);
        const direction = sell ? 'Bearish':'Bullish';
        const zone = f.engine.getState().activeFVGs.find(z => z.timestamp === f.input[19].timestamp && z.direction === direction)!;
        const top = sell ? 124:101, bottom = sell ? 119:96;
        const at = f.input.at(-1)!.timestamp;
        const check = (patch: any = {}, observedAt = at, history = f.input) => hasActiveAdjacentFVG(history,18,!sell,top,bottom,{zones:[{...zone,...patch}],observedAt});
        assert.equal(check(),true,'closed interval exact contact');
        assert.equal(check({availableAt:f.input[20].timestamp}),true,'exact third bar availability');
        for (const patch of [{direction:sell?'Bullish':'Bearish'}, {is_ifvg:true}, {mitigated:true},
            {timestamp:f.input[18].timestamp}, {availableAt:at+1}, {availableAt:NaN}, {availableAt:null},
            {availableAt:f.input[19].timestamp}, {top:NaN}, {bottom:Infinity}, {top:0,bottom:1},
            sell ? {top:bottom-0.00001,bottom:bottom-1} : {top:top+1,bottom:top+0.00001}]) {
            assert.equal(check(patch),false,JSON.stringify(patch));
        }
        assert.equal(check({},f.input[19].timestamp),false,'central candle is not availability');
        assert.equal(check({},NaN),false);
        assert.equal(check({},at,f.input.slice(0,20)),false,'third bar absent');
        const discontinuous = f.input.map(c => ({...c}));
        discontinuous[20].timestamp = at+STEP;
        assert.equal(check({},at,discontinuous),false,'derive legacy availability from actual third bar, not nominal offset');
        const noGap = f.input.map(c => ({...c}));
        if (sell) noGap[20].high = noGap[18].low;
        else noGap[20].low = noGap[18].high;
        assert.equal(check({},at,noGap),false,'directional formation required');
    });
    for (const kind of ['crt','coiled'] as const) test('isolation',`${side}: ${kind} does not contaminate same-bar legacy or next native BOS`, () => {
        const pairs = [true,false].map(enabled => {
            const f = fixture(kind,enabled,sell,'H1',{fvg_min_atr_factor:.1});
            const last = f.input.at(-1)!;
            const replacement = kind === 'crt' ? bar(21,103,106,102,105) : bar(22,104,108,103,107);
            Object.assign(last,sell ? mirror(replacement):replacement);
            const contexts: any[] = [];
            const create = f.engine.orderBlocks.createStructuralOB.bind(f.engine.orderBlocks);
            f.engine.orderBlocks.createStructuralOB = (ev,atr,preset,context) => { contexts.push({...context}); return create(ev,atr,preset,context); };
            const legacyContexts: any[] = [];
            const createLegacy = f.engine.orderBlocks.createLegacyOB.bind(f.engine.orderBlocks);
            f.engine.orderBlocks.createLegacyOB = (ev,atr,preset,context) => { legacyContexts.push({...context}); return createLegacy(ev,atr,preset,context); };
            const events = f.run();
            const ob = structural(events).ob;
            const legacy = events.filter((e:any) => e.type === 'EVENT_OB_CREATED' && e.ob.category === 'Legacy');
            assert.ok(legacy.length>0,'nonempty same-bar real FVG/Legacy positive control');
            assert.equal(contexts.length,1); assert.ok(legacyContexts.length>0);
            for (const c of legacyContexts) { assert.equal(c.crtOrigin,undefined); assert.equal(c.isCoiled,undefined); assert.equal(c.activeFVGSnapshot,undefined); }
            const state = f.engine.getState();
            (sell ? state.pivotsLow : state.pivotsHigh).push({index:f.input.length-1,timestamp:last.timestamp,price:sell?113:107,type:sell?'Low':'High',isBroken:false});
            const next = bar(f.input.length,107,111,106,110);
            const nextEvents = f.engine.nextCandle(sell ? mirror(next):next);
            assert.ok(nextEvents.some(e => e.type === 'EVENT_BOS'),'next event is actual native BOS');
            assert.equal(contexts.length,2);
            assert.equal(contexts[1].crtOrigin,false); assert.equal(contexts[1].isCoiled,false);
            assert.notEqual(contexts[0],contexts[1]);
            return {ob,legacy};
        });
        assert.equal(pairs[0].ob.score,pairs[1].ob.score+(kind === 'crt'?2:3));
        assert.deepEqual(pairs[0].legacy.map((e:any)=>e.ob.score),pairs[1].legacy.map((e:any)=>e.ob.score));
    });
}
for (const sell of [false,true]) for (const kind of ['crt','coiled'] as const) {
    test('natural',`${sell?'SELL':'BUY'}: ${kind} traverses OHLC → native pivots → structure → OB without seeding`, () => {
        const scores = [true,false].map(enabled => {
            const bars = Array.from({length:18},(_,i) => bar(i,110,111,109,110.2));
            if (kind === 'coiled') {
                bars[17] = bar(17,110,111,95,105); // avoid a dual high/low mother pivot (native high wins ties)
                bars.push(bar(18,101,114,96,99),bar(19,enabled?100:95.8,104,enabled?97:95.5,enabled?99:95.6),bar(20,99,104,98,100),bar(21,99,104,98,100),bar(22,112,116,110,115));
            }
            else bars.push(bar(18,100,102,98,100),bar(19,100,102,98,100),bar(20,100,102,98,100),bar(21,101,104,97,99),bar(22,99,103,97,enabled?101:99.5),bar(23,99,101,96,98),bar(24,98,101,97,100),bar(25,103,106,102,105));
            const engine = new SMCEngine({...getPreset('Forex - 3. Balanceado'),pivot_len:3},'H1');
            let events: any[] = [];
            for (const c of sell?bars.map(mirror):bars) events = engine.nextCandle(c);
            const {ev,ob} = structural(events);
            assert.equal(kind === 'crt'?ev.crtOrigin:ev.isCoiled,enabled);
            assert.ok((sell?engine.getState().pivotsLow:engine.getState().pivotsHigh).length>0,'native pivot confirmed');
            return ob.score;
        });
        assert.equal(scores[0],scores[1]+(kind==='crt'?2:3));
    });
}
for (const sell of [false,true]) for (const kind of ['crt','coiled'] as const) test('bos',`${sell?'SELL':'BUY'}: BOS preserves per-event ${kind} and unchanged base points`, () => {
    for (const enabled of [true,false]) {
        const bos = fixture(kind,enabled,sell);
        (bos.engine as any).structure.currentTrend = sell?'Bearish':'Bullish';
        const actual = structural(bos.run());
        const choch = structural(fixture(kind,enabled,sell).run());
        assert.equal(actual.ev.type,'EVENT_BOS');
        assert.equal(kind==='crt'?actual.ev.crtOrigin:actual.ev.isCoiled,enabled);
        assert.equal(actual.ob.score,choch.ob.score+2,'BOS base remains 2, CHoCH base remains 0');
    }
});
test('fvg','old direct hasFvgNear boolean remains supported without a native snapshot', () => {
    for (const sell of [false,true]) {
        const calc = (context: any) => {
            const f = fixture('crt',false,sell);
            f.engine.orderBlocks.updateHistory(f.input.at(-1)!);
            return f.engine.orderBlocks.createStructuralOB({type:'EVENT_BOS',direction:sell?'Bearish':'Bullish'},1,f.preset,context)[0].score;
        };
        const base = calc({});
        assert.equal(calc({hasFvgNear:true}),base+1);
        assert.equal(calc({hasFvgNear:true,activeFVGSnapshot:{zones:[],observedAt:BASE+100*STEP}}),base,'native snapshot never falls back to an unproven boolean');
    }
});
for (const sell of [false,true]) test('fvg',`${sell?'SELL':'BUY'}: experimental real FVG availability is causal at the native structural caller`, () => {
    const opts: Partial<SMCPreset> = {signal_profile:'directional_atr_v1'};
    const near = fvgFixture(sell,'near',opts);
    const target = near.engine.getState().activeFVGs.find(z => z.timestamp === near.input[19].timestamp && z.direction === (sell?'Bearish':'Bullish'))!;
    assert.equal(target.availableAt,near.input[20].timestamp,'native detector third-bar timestamp, not middle origin');
    const yes = structural(near.run());
    assert.equal(yes.ev.availableAt,near.input[21].timestamp+STEP);
    for (const kind of ['removed','future','mitigated','far']) {
        const no = structural(fvgFixture(sell,kind,opts).run());
        assert.equal(yes.ob.score,no.ob.score+1,kind);
    }
});
test('fvg','adjacency helper retains all three existing formation offsets, and excludes k=3', () => {
    for (const sell of [false,true]) for (const offset of [0,1,2,3]) {
        const raw = Array.from({length:7},(_,i) => bar(i,9,10,8,9));
        raw[offset+2] = bar(offset+2,12,14,12,13);
        const history = sell?raw.map(mirror):raw;
        const zone = {id:'fixture',timestamp:history[offset+1].timestamp,direction:sell?'Bearish' as const:'Bullish' as const,top:sell?210:12,bottom:sell?208:10,mitigated:false,is_ifvg:false};
        assert.equal(hasActiveAdjacentFVG(history,0,!sell,sell?212:10,sell?210:8,{zones:[zone],observedAt:history.at(-1)!.timestamp}),offset<=2,`${sell} k=${offset}`);
    }
});
log(JSON.stringify({mode,count,failures}));
assert.ok(count > 0,'no vacuous test selector');
if (failures) process.exitCode=1;
