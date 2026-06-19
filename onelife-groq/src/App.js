import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ════════════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════════════
const VERSION       = "4.0.0";
const POP_SIZE      = 20;
const ELITE_KEEP    = 4;
const MUTATION_RATE = 0.25;
const MIN_TRADES    = 12;
const STORAGE_KEY   = "onelife_v4";

const SESSION_SPREAD = { london:2, nyOpen:3, nyAM:4, nyPM:8, overnight:12 };
const SESSION_SLIP   = { london:1, nyOpen:1.5, nyAM:2, nyPM:4, overnight:6 };

const GENE_RANGES = {
  sweepLookback:    [3,  15, false],
  sweepBuffer:      [1.001,1.007,true],
  rrRatio:          [1.5,3.5, true],
  bbConfirmBars:    [2,  10, false],
  ifvgConfirmBars:  [2,  7,  false],
  sweepWindow:      [4,  16, false],
  minRiskPts:       [5,  40, true],
  htfBiasWeight:    [0,  1,  true],
  qualityThreshold: [0,  3,  false],
  breakEvenTrigger: [0.5,1.5,true],
  pdArrayStrict:    [0,  1,  true],   // 0=loose 1=strict premium/discount
  displacementMin:  [0.3,2.0,true],   // min displacement multiplier
};

const MACRO_WINDOWS = [
  {l:"7:50–8:10",   s:[7,50], e:[8,10],  session:"london"},
  {l:"8:50–9:10",   s:[8,50], e:[9,10],  session:"london"},
  {l:"9:50–10:10",  s:[9,50], e:[10,10], session:"nyOpen"},
  {l:"10:50–11:10", s:[10,50],e:[11,10], session:"nyAM"},
  {l:"11:50–12:10", s:[11,50],e:[12,10], session:"nyAM"},
  {l:"1:20–1:40",   s:[13,20],e:[13,40], session:"nyPM"},
  {l:"2:50–3:10",   s:[14,50],e:[15,10], session:"nyPM"},
  {l:"3:15–3:45",   s:[15,15],e:[15,45], session:"nyPM"},
  {l:"3:50–4:10",   s:[15,50],e:[16,10], session:"nyPM"},
];

const HIGH_IMPACT_KEYWORDS = ["fed","fomc","cpi","nfp","gdp","rate decision","payroll","inflation","unemployment","pce"];

// ════════════════════════════════════════════════════════════════
//  STORAGE
// ════════════════════════════════════════════════════════════════
// Environment variables (from .env file)
const GROQ_KEY    = process.env.REACT_APP_GROQ_KEY    || "";
const POLYGON_KEY   = process.env.REACT_APP_POLYGON_KEY   || "";
const TG_TOKEN      = process.env.REACT_APP_TG_TOKEN      || "";
const TG_CHAT       = process.env.REACT_APP_TG_CHAT       || "";

const store = {
  save:  async v => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch {} },
  load:  async () => { try { const r=localStorage.getItem(STORAGE_KEY); return r?JSON.parse(r):null; } catch { return null; } },
  clear: async () => { try { localStorage.removeItem(STORAGE_KEY); } catch {} },
};

// ════════════════════════════════════════════════════════════════
//  CANDLE GENERATION  (regime-aware, session-stamped)
// ════════════════════════════════════════════════════════════════
function getSessionForBar(i, totalBars) {
  const pct = (i % 390) / 390; // simulate a trading day cycle
  if (pct < 0.10) return "london";
  if (pct < 0.25) return "nyOpen";
  if (pct < 0.55) return "nyAM";
  if (pct < 0.85) return "nyPM";
  return "overnight";
}

function genCandles(n=500, seed=1) {
  const c=[]; let p=18500+(seed*137)%1500, trend=0, tLen=0, vol=30;
  for(let i=0;i<n;i++){
    if(tLen<=0){ trend=(Math.random()-.47)*1.6; tLen=8+Math.floor(Math.random()*28); vol=15+Math.random()*60; }
    tLen--;
    const session=getSessionForBar(i,n);
    const sessionVol={london:1.1,nyOpen:1.4,nyAM:1.0,nyPM:0.8,overnight:0.5}[session];
    const b=Math.random()<(0.5+trend*0.28)?1:-1;
    const range=vol*sessionVol*(0.6+Math.random()*0.8);
    const o=p, cl=p+b*range*.65+trend*range*.18;
    const h=Math.max(o,cl)+Math.random()*range*.35, l=Math.min(o,cl)-Math.random()*range*.35;
    c.push({open:o,close:cl,high:h,low:l,index:i,
      volume:Math.floor((500+Math.random()*4000)*sessionVol),
      session, ts:Date.now()-(n-i)*60000});
    p=cl;
  }
  return c;
}

// ════════════════════════════════════════════════════════════════
//  HTF BUILDER  (15-min and 1-hour)
// ════════════════════════════════════════════════════════════════
function buildHTF(candles, period=15) {
  const htf=[];
  for(let i=0;i+period<=candles.length;i+=period){
    const sl=candles.slice(i,i+period);
    htf.push({ open:sl[0].open, close:sl[sl.length-1].close,
      high:Math.max(...sl.map(c=>c.high)), low:Math.min(...sl.map(c=>c.low)),
      index:Math.floor(i/period), barStart:i });
  }
  return htf;
}

function getHTFBias(htf, barIndex, period=15) {
  const idx=Math.floor(barIndex/period);
  if(idx<2) return 0;
  const cur=htf[idx], prev=htf[idx-1]; if(!cur||!prev) return 0;
  return cur.close<cur.open&&prev.close<prev.open?-1:cur.close>cur.open&&prev.close>prev.open?1:0;
}

// ════════════════════════════════════════════════════════════════
//  PREMIUM / DISCOUNT ARRAY DETECTOR
// ════════════════════════════════════════════════════════════════
function getPDLevel(candles, i, lookback=50) {
  const window=candles.slice(Math.max(0,i-lookback),i);
  if(window.length<10) return {level:"mid",pct:0.5};
  const hi=Math.max(...window.map(c=>c.high));
  const lo=Math.min(...window.map(c=>c.low));
  const range=hi-lo||1;
  const pct=(candles[i].close-lo)/range;
  const level=pct>0.7?"premium":pct<0.3?"discount":"mid";
  return {level,pct,hi,lo,range};
}

// ════════════════════════════════════════════════════════════════
//  EQUAL HIGHS / LOWS DETECTOR
// ════════════════════════════════════════════════════════════════
function findEqualHighsLows(candles, i, lookback=30, tolerance=0.002) {
  const window=candles.slice(Math.max(0,i-lookback),i);
  const swingHighs=[], swingLows=[];
  for(let j=1;j<window.length-1;j++){
    if(window[j].high>window[j-1].high&&window[j].high>window[j+1].high) swingHighs.push(window[j].high);
    if(window[j].low<window[j-1].low&&window[j].low<window[j+1].low)   swingLows.push(window[j].low);
  }
  const equalHighs=swingHighs.filter(h=>swingHighs.filter(h2=>Math.abs(h2-h)/h<tolerance).length>=2);
  const equalLows =swingLows.filter(l=>swingLows.filter(l2=>Math.abs(l2-l)/l<tolerance).length>=2);
  return { equalHighs:[...new Set(equalHighs.map(h=>+h.toFixed(1)))],
           equalLows:[...new Set(equalLows.map(l=>+l.toFixed(1)))] };
}

// ════════════════════════════════════════════════════════════════
//  DISPLACEMENT DETECTOR
// ════════════════════════════════════════════════════════════════
function detectDisplacement(candles, i, minMultiplier=1.0) {
  if(i<5) return false;
  const recent=candles.slice(i-5,i);
  const avgRange=recent.reduce((a,c)=>a+(c.high-c.low),0)/recent.length||1;
  const cur=candles[i];
  const curRange=cur.high-cur.low;
  const isBearish=cur.close<cur.open;
  const body=Math.abs(cur.close-cur.open);
  return isBearish && curRange>avgRange*minMultiplier && body/curRange>0.6;
}

// ════════════════════════════════════════════════════════════════
//  SESSION CLASSIFIER
// ════════════════════════════════════════════════════════════════
function classifySession(h, m) {
  const hm=h*100+m;
  if(hm>=200&&hm<830)   return "london";
  if(hm>=930&&hm<1100)  return "nyOpen";
  if(hm>=1100&&hm<1330) return "nyAM";
  if(hm>=1330&&hm<1600) return "nyPM";
  return "overnight";
}

function isInMacro(h,m) {
  return MACRO_WINDOWS.some(w=>(h>w.s[0]||(h===w.s[0]&&m>=w.s[1]))&&(h<w.e[0]||(h===w.e[0]&&m<w.e[1])));
}

// ════════════════════════════════════════════════════════════════
//  KILL ZONE TRACKER  (per macro window performance)
// ════════════════════════════════════════════════════════════════
function buildKillZoneStats(trades) {
  const stats={};
  MACRO_WINDOWS.forEach(w=>{ stats[w.l]={wins:0,losses:0,pnl:0,total:0}; });
  trades.forEach(t=>{
    if(!t.macroWindow||t.result==="open") return;
    const s=stats[t.macroWindow];
    if(!s) return;
    s.total++; s.pnl+=t.pnl;
    if(t.result==="WIN") s.wins++; else s.losses++;
  });
  return stats;
}

// ════════════════════════════════════════════════════════════════
//  GENETIC ALGORITHM
// ════════════════════════════════════════════════════════════════
function randomGene(k){ const [mn,mx,isF]=GENE_RANGES[k]; const v=mn+Math.random()*(mx-mn); return isF?+v.toFixed(4):Math.round(v); }
function randomDNA(gen=1){ const d={generation:gen,id:Math.random().toString(36).slice(2,8)}; Object.keys(GENE_RANGES).forEach(k=>d[k]=randomGene(k)); return d; }
function mutateDNA(parent,gen,forceMutate=[]){ const c={...parent,generation:gen,id:Math.random().toString(36).slice(2,8)}; Object.keys(GENE_RANGES).forEach(k=>{ if(Math.random()<MUTATION_RATE||forceMutate.includes(k)){ const [mn,mx,isF]=GENE_RANGES[k]; const delta=(mx-mn)*(Math.random()*0.3-0.15); const v=Math.max(mn,Math.min(mx,parent[k]+delta)); c[k]=isF?+v.toFixed(4):Math.round(v); } }); return c; }
function crossover(a,b,gen){ const c={generation:gen,id:Math.random().toString(36).slice(2,8)}; Object.keys(GENE_RANGES).forEach(k=>c[k]=Math.random()<0.5?a[k]:b[k]); return c; }

function fitnessScore(stats) {
  if(!stats||stats.total<MIN_TRADES) return -999;
  const ddPen=Math.max(0,stats.maxDD-100)*0.02;
  const clPen=Math.max(0,stats.maxCL-4)*0.5;
  const freq=Math.min(1,stats.total/30);
  return (stats.profitFactor*2)+(stats.winRate*3)+(stats.sharpe*1.5)+(freq*0.5)-ddPen-clPen;
}

function nextGeneration(pop, gen, forceMutate=[]) {
  const ranked=[...pop].sort((a,b)=>(b.fitness||0)-(a.fitness||0));
  const elite=ranked.slice(0,ELITE_KEEP);
  const children=[];
  while(children.length<POP_SIZE-ELITE_KEEP){
    const r=Math.random();
    if(r<0.35&&elite.length>=2){ const [p1,p2]=[...elite].sort(()=>Math.random()-.5).slice(0,2); children.push(mutateDNA(crossover(p1.dna,p2.dna,gen),gen,forceMutate)); }
    else if(r<0.65){ children.push(mutateDNA(elite[Math.floor(Math.random()*elite.length)].dna,gen,forceMutate)); }
    else{ children.push(randomDNA(gen)); }
  }
  return [...elite.map(e=>({...e,dna:{...e.dna,generation:gen}})),...children.map(dna=>({dna,stats:null,fitness:null,status:"pending"}))];
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY ENGINE  (full ICT with all detectors)
// ════════════════════════════════════════════════════════════════
function runStrategy(candles, dna, htf15) {
  const sigs=[];
  for(let i=Math.max(5,dna.sweepLookback);i<candles.length;i++){
    const c=candles[i];
    const session=c.session||"nyAM";
    const spread=SESSION_SPREAD[session]||3;

    // Sweep
    const ph=Math.max(...candles.slice(i-dna.sweepLookback,i).map(x=>x.high));
    if(c.high>ph&&c.close<ph) sigs.push({type:"SWEEP",index:i,price:c.high,ph});

    // Breaker block
    if(i>=1){ const p2=candles[i-1]; if(p2.close>p2.open&&c.close<c.open&&c.close<p2.open) sigs.push({type:"BB",index:i,high:p2.high,low:p2.low}); }

    // IFVG
    if(i>=2){ const a=candles[i-2]; if(a.low>c.high) sigs.push({type:"IFVG",index:i,top:a.low,bottom:c.high}); }

    // Order block
    if(i>=1){ const rng=c.high-c.low,body=Math.abs(c.close-c.open); if(body/rng>0.72&&c.close<c.open) sigs.push({type:"OB",index:i,high:c.high,low:c.low}); }

    // Displacement
    if(detectDisplacement(candles,i,dna.displacementMin)) sigs.push({type:"DISP",index:i,price:c.close});

    // Equal highs nearby
    const eql=findEqualHighsLows(candles,i,30);
    if(eql.equalHighs.length>=1) sigs.push({type:"EQH",index:i,levels:eql.equalHighs});

    // Entry logic
    const rSweep=sigs.find(s=>s.type==="SWEEP"&&i-s.index<=dna.sweepWindow&&i-s.index>=1);
    const rBB   =sigs.find(s=>s.type==="BB"   &&i-s.index<=dna.bbConfirmBars&&i-s.index>=0);
    const rIFVG =sigs.find(s=>s.type==="IFVG" &&i-s.index<=dna.ifvgConfirmBars&&i-s.index>=0);
    const rOB   =sigs.find(s=>s.type==="OB"   &&i-s.index<=dna.bbConfirmBars&&i-s.index>=0);
    const rDisp =sigs.find(s=>s.type==="DISP" &&i-s.index<=3&&i-s.index>=0);
    const rEQH  =sigs.find(s=>s.type==="EQH"  &&i-s.index<=10&&i-s.index>=0);

    const quality=(rBB?1:0)+(rIFVG?1:0)+(rOB?1:0)+(rDisp?1:0)+(rEQH?1:0);
    if(!rSweep||(quality<dna.qualityThreshold)) continue;
    if(!(rBB||rIFVG||rOB)) continue;

    // HTF bias — skip if HTF is bullish (we only short)
    const htfBias=htf15?getHTFBias(htf15,i):0;
    if(dna.htfBiasWeight>0.5&&htfBias===1) continue;

    // Premium/discount filter — only short from premium
    const pd=getPDLevel(candles,i);
    if(dna.pdArrayStrict>0.5&&pd.level!=="premium") continue;

    const slip=SESSION_SLIP[session]||2;
    const entry=c.open+slip;
    const sl=rSweep.price*dna.sweepBuffer+spread;
    const risk=sl-entry;
    if(risk<dna.minRiskPts||risk>300) continue;
    const tp=entry-risk*dna.rrRatio;

    // Find which macro window
    const nowH=Math.floor((i%390)/60*0.9+7), nowM=(i%60);
    const macro=MACRO_WINDOWS.find(w=>(nowH>w.s[0]||(nowH===w.s[0]&&nowM>=w.s[1]))&&(nowH<w.e[0]||(nowH===w.e[0]&&nowM<w.e[1])));

    sigs.push({type:"ENTRY",index:i,price:entry,sl,tp,risk,quality,session,
      pd:pd.level,htfBias,hasDisp:!!rDisp,hasEQH:!!rEQH,
      macroWindow:macro?.l||null,
      confirms:[rBB?"BB":null,rIFVG?"IFVG":null,rOB?"OB":null,rDisp?"DISP":null,rEQH?"EQH":null].filter(Boolean)});
  }
  return sigs;
}

// ════════════════════════════════════════════════════════════════
//  PROFESSIONAL BACKTESTER  (session-aware spread, partial TP)
// ════════════════════════════════════════════════════════════════
function backtest(candles, dna, htf15) {
  const sigs=runStrategy(candles,dna,htf15);
  const entries=sigs.filter(s=>s.type==="ENTRY");
  const trades=[], used=new Set();
  entries.forEach(e=>{
    if(used.has(e.index)) return;
    const session=e.session||"nyAM";
    const slip=SESSION_SLIP[session]||2;
    let sl=e.sl, beTriggered=false, result="open", exitPrice=null, barsHeld=0;
    let tp1Hit=false, tp1Price=e.price-(e.price-e.tp)*0.5; // 50% partial at 1:1
    let remainingPnl=0;

    for(let j=e.index+1;j<candles.length&&barsHeld<120;j++){
      const c=candles[j]; barsHeld++;
      if(!beTriggered&&c.low<=e.price-e.risk*dna.breakEvenTrigger){ sl=e.price+slip; beTriggered=true; }
      if(!tp1Hit&&c.low<=tp1Price){ tp1Hit=true; remainingPnl+=(e.price-tp1Price)*0.5; }
      if(c.high>=sl){ result="LOSS"; exitPrice=sl+slip; break; }
      if(c.low<=e.tp){ result="WIN"; exitPrice=e.tp-slip; break; }
      if(barsHeld>=120){ result="TIMEOUT"; exitPrice=c.close; break; }
    }
    used.add(e.index);
    let pnl=remainingPnl;
    if(result==="WIN")  pnl+=(e.price-exitPrice)*0.5;
    else if(result==="LOSS") pnl-=(exitPrice-e.price)*(tp1Hit?0.5:1.0);
    else pnl+=(e.price-(exitPrice||e.price))*0.5;
    trades.push({...e,result,exitPrice,barsHeld,pnl,beTriggered,tp1Hit});
  });

  const closed=trades.filter(t=>t.result!=="open");
  const wins=closed.filter(t=>t.result==="WIN");
  const losses=closed.filter(t=>t.result==="LOSS");
  const totalPnl=closed.reduce((a,t)=>a+t.pnl,0);
  const winRate=closed.length?wins.length/closed.length:0;
  const avgWin=wins.length?wins.reduce((a,t)=>a+t.pnl,0)/wins.length:0;
  const avgLoss=losses.length?Math.abs(losses.reduce((a,t)=>a+t.pnl,0)/losses.length):1;
  const profitFactor=losses.length?(wins.length*avgWin)/(losses.length*avgLoss):wins.length>0?99:0;
  let peak=0,eq=0,maxDD=0; closed.forEach(t=>{eq+=t.pnl;if(eq>peak)peak=eq;maxDD=Math.max(maxDD,peak-eq);});
  const pnls=closed.map(t=>t.pnl); const mean=pnls.reduce((a,b)=>a+b,0)/(pnls.length||1);
  const std=Math.sqrt(pnls.reduce((a,b)=>a+(b-mean)**2,0)/(pnls.length||1))||1;
  const sharpe=mean/std;
  let maxCL=0,cl=0; closed.forEach(t=>{t.result==="LOSS"?(cl++,maxCL=Math.max(maxCL,cl)):cl=0;});
  const kzStats=buildKillZoneStats(trades);
  const sessionStats={london:{w:0,l:0,pnl:0},nyOpen:{w:0,l:0,pnl:0},nyAM:{w:0,l:0,pnl:0},nyPM:{w:0,l:0,pnl:0}};
  closed.forEach(t=>{ const s=sessionStats[t.session]; if(s){ s.pnl+=t.pnl; t.result==="WIN"?s.w++:s.l++; } });

  return {trades,wins:wins.length,losses:losses.length,total:closed.length,
    totalPnl,winRate,avgWin,avgLoss,profitFactor,maxDD,sharpe,maxCL,kzStats,sessionStats};
}

// ════════════════════════════════════════════════════════════════
//  MONTE CARLO
// ════════════════════════════════════════════════════════════════
function monteCarlo(stats, runs=300) {
  if(!stats||stats.total<5) return null;
  const pnls=stats.trades.filter(t=>t.result!=="open").map(t=>t.pnl);
  const results=[];
  for(let r=0;r<runs;r++){
    const sh=[...pnls].sort(()=>Math.random()-.5);
    let eq=0,pk=0,dd=0,mdd=0; sh.forEach(p=>{eq+=p;if(eq>pk)pk=eq;dd=pk-eq;if(dd>mdd)mdd=dd;});
    results.push({eq,mdd});
  }
  results.sort((a,b)=>a.eq-b.eq);
  return { p5:results[Math.floor(runs*.05)].eq, median:results[Math.floor(runs/2)].eq,
    p95:results[Math.floor(runs*.95)].eq, worstDD:Math.max(...results.map(r=>r.mdd)),
    ruin:results.filter(r=>r.eq<-500).length/runs };
}

// ════════════════════════════════════════════════════════════════
//  CLAUDE AI  — population advisor
// ════════════════════════════════════════════════════════════════
async function claudeAdvise(champion, population, generation) {
  const top5=[...population].sort((a,b)=>(b.fitness||0)-(a.fitness||0)).slice(0,5).map(p=>({
    id:p.dna.id, fitness:(p.fitness||0).toFixed(2),
    wr:p.stats?((p.stats.winRate||0)*100).toFixed(0)+"%":"N/A",
    pf:p.stats?(p.stats.profitFactor||0).toFixed(2):"N/A",
    dd:p.stats?(p.stats.maxDD||0).toFixed(0):"N/A",
    genes:{sweepLookback:p.dna.sweepLookback,rrRatio:p.dna.rrRatio,sweepBuffer:p.dna.sweepBuffer,
      minRiskPts:p.dna.minRiskPts,qualityThreshold:p.dna.qualityThreshold,
      pdArrayStrict:p.dna.pdArrayStrict,displacementMin:p.dna.displacementMin,breakEvenTrigger:p.dna.breakEvenTrigger}
  }));
  const sessStats=champion?.stats?.sessionStats;
  const kzStats=champion?.stats?.kzStats;
  const bestKZ=kzStats?Object.entries(kzStats).sort((a,b)=>(b[1].pnl||0)-(a[1].pnl||0)).slice(0,3).map(([k,v])=>`${k}: ${v.pnl?.toFixed(0)}pts ${v.total}trades`).join(", "):"N/A";

  const prompt=`You are a quantitative ICT trading strategy evolution advisor for a genetic algorithm.

Generation: ${generation} | Pop: ${POP_SIZE}
Champion fitness: ${(champion?.fitness||0).toFixed(2)}
Champion: WR=${((champion?.stats?.winRate||0)*100).toFixed(0)}% PF=${(champion?.stats?.profitFactor||0).toFixed(2)} DD=${(champion?.stats?.maxDD||0).toFixed(0)}pts Sharpe=${(champion?.stats?.sharpe||0).toFixed(2)}

Session performance: London W=${sessStats?.london?.w||0} L=${sessStats?.london?.l||0} | NYOpen W=${sessStats?.nyOpen?.w||0} L=${sessStats?.nyOpen?.l||0} | NYAM W=${sessStats?.nyAM?.w||0} L=${sessStats?.nyAM?.l||0} | NYPM W=${sessStats?.nyPM?.w||0} L=${sessStats?.nyPM?.l||0}

Best kill zones: ${bestKZ}

Top 5 organisms: ${JSON.stringify(top5,null,2)}

Gene ranges: sweepLookback 3-15, sweepBuffer 1.001-1.007, rrRatio 1.5-3.5, bbConfirmBars 2-10, ifvgConfirmBars 2-7, sweepWindow 4-16, minRiskPts 5-40, htfBiasWeight 0-1, qualityThreshold 0-3, breakEvenTrigger 0.5-1.5, pdArrayStrict 0-1, displacementMin 0.3-2.0

Identify patterns in top performers. Note which sessions are profitable vs losing. Suggest which genes to force-mutate.

Respond ONLY with valid JSON (no markdown):
{"insight":"<2 sentences>","recommend":"<1 sentence>","forceMutateGenes":["gene1"],"diversityInjection":<bool>,"sessionAdvice":"<which session to focus on>","confidence":<1-10>}`;

  const resp=await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_KEY}`},
    body:JSON.stringify({model:"llama-3.1-70b-versatile",max_tokens:700,messages:[{role:"user",content:prompt}]})
  });
  const data=await resp.json();
  const txt=(data.choices?.[0]?.message?.content||"").replace(/```json|```/g,"").trim(); return JSON.parse(txt);
}

// ════════════════════════════════════════════════════════════════
//  TELEGRAM ALERT
// ════════════════════════════════════════════════════════════════
async function sendTelegram(botToken, chatId, message) {
  if(!botToken||!chatId) return false;
  try {
    const url=`https://api.telegram.org/bot${botToken}/sendMessage`;
    const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:chatId,text:message,parse_mode:"HTML"})});
    return r.ok;
  } catch { return false; }
}

function buildSignalMessage(signal, champion) {
  return `🚨 <b>ONE LIFE — SIGNAL</b>

📉 <b>SHORT ENTRY</b>
• Entry: <code>${signal.price.toFixed(1)}</code>
• Stop Loss: <code>${signal.sl.toFixed(1)}</code>
• Take Profit: <code>${signal.tp.toFixed(1)}</code>
• Risk: <code>${signal.risk.toFixed(1)} pts</code>
• R:R: <code>1:${champion?.dna?.rrRatio||2}</code>

✅ Confirms: ${signal.confirms?.join(", ")||"—"}
📊 Quality: ${signal.quality||0}/5
🕐 Session: ${signal.session||"—"}
📍 PD Array: ${signal.pd||"—"}
${signal.hasDisp?"⚡ Displacement confirmed":""}
${signal.hasEQH?"🎯 Equal highs nearby":""}

⚠️ Demo account only. Not financial advice.`;
}

// ════════════════════════════════════════════════════════════════
//  POLYGON.IO DATA
// ════════════════════════════════════════════════════════════════
async function fetchPolygon(ticker, apiKey, days=5) {
  const to=new Date().toISOString().split("T")[0];
  const from=new Date(Date.now()-days*864e5).toISOString().split("T")[0];
  const url=`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=500&apiKey=${apiKey}`;
  const r=await fetch(url); const d=await r.json();
  if(!d.results?.length) throw new Error(d.message||"No data returned");
  return d.results.map((b,i)=>({open:b.o,close:b.c,high:b.h,low:b.l,volume:b.v,index:i,ts:b.t,session:getSessionForBar(i,d.results.length)}));
}

async function checkNewsBlock(apiKey) {
  if(!apiKey) return false;
  try {
    const url=`https://api.polygon.io/v2/reference/news?limit=10&apiKey=${apiKey}`;
    const r=await fetch(url); const d=await r.json();
    const now=Date.now();
    return (d.results||[]).some(n=>{
      const age=now-new Date(n.published_utc).getTime();
      return age<3600000&&HIGH_IMPACT_KEYWORDS.some(k=>n.title?.toLowerCase().includes(k));
    });
  } catch { return false; }
}

// ════════════════════════════════════════════════════════════════
//  TRADE JOURNAL  (with full context)
// ════════════════════════════════════════════════════════════════
function JournalRow({trade, i}) {
  const [exp, setExp]=useState(false);
  const c=trade.result==="WIN"?"#4ade80":trade.result==="LOSS"?"#f87171":"#f59e0b";
  return (
    <div style={{borderBottom:"1px solid #071525",cursor:"pointer"}} onClick={()=>setExp(!exp)}>
      <div style={{display:"flex",gap:8,padding:"5px 8px",fontSize:8,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{color:"#334155",minWidth:20}}>#{i+1}</span>
        <span style={{color:c,fontWeight:700,minWidth:40}}>{trade.result}</span>
        <span style={{color:"#1e3a5f",minWidth:60}}>@{trade.price?.toFixed(0)}</span>
        <span style={{color:trade.pnl>=0?"#4ade80":"#f87171",minWidth:60}}>{trade.pnl>=0?"+":""}{trade.pnl?.toFixed(1)}pts</span>
        <span style={{color:"#0d2235",minWidth:50}}>{trade.session}</span>
        <span style={{color:"#0d2235"}}>{trade.confirms?.join(",")||"—"}</span>
        <span style={{color:"#0d2235",marginLeft:"auto"}}>{trade.pd}</span>
        <span style={{color:"#071525"}}>{exp?"▲":"▼"}</span>
      </div>
      {exp&&<div style={{padding:"6px 12px",background:"#020b16",fontSize:8,color:"#334155",lineHeight:2}}>
        <div>Entry: {trade.price?.toFixed(2)} | SL: {trade.sl?.toFixed(2)} | TP: {trade.tp?.toFixed(2)}</div>
        <div>Risk: {trade.risk?.toFixed(1)}pts | Quality: {trade.quality}/5 | Bars held: {trade.barsHeld}</div>
        <div>HTF Bias: {trade.htfBias===1?"Bullish":trade.htfBias===-1?"Bearish":"Neutral"} | PD: {trade.pd}</div>
        <div>Displacement: {trade.hasDisp?"✅":"❌"} | Equal Highs: {trade.hasEQH?"✅":"❌"} | Breakeven: {trade.beTriggered?"✅":"❌"}</div>
        <div>Macro Window: {trade.macroWindow||"—"} | TP1 Hit: {trade.tp1Hit?"✅":"❌"}</div>
      </div>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  CHARTS
// ════════════════════════════════════════════════════════════════
const CW=8,CG=2,CH=240,CWIDTH=650,CVIS=Math.floor(CWIDTH/(CW+CG));

function PriceChart({candles,signals,offset,trades,pdZones}) {
  const vis=candles.slice(offset,offset+CVIS);
  if(!vis.length) return null;
  const px=vis.flatMap(c=>[c.high,c.low]);
  const mn=Math.min(...px),mx=Math.max(...px),rng=mx-mn||1,pd=14;
  const toY=p=>pd+((mx-p)/rng)*(CH-pd*2);
  const vSigs=signals.filter(s=>s.index>=offset&&s.index<offset+CVIS);
  const trMap={}; (trades||[]).forEach(t=>{if(t.index>=offset&&t.index<offset+CVIS)trMap[t.index]=t;});
  const sessColors={london:"#0d1f2d",nyOpen:"#0d2010",nyAM:"#0a1a0d",nyPM:"#1a100d",overnight:"#1a1a2d"};
  return (
    <svg width={CWIDTH} height={CH} style={{display:"block",background:"#020b16"}}>
      {/* Session backgrounds */}
      {vis.map((c,xi)=>{
        const x=xi*(CW+CG);
        const prevSess=xi>0?vis[xi-1].session:null;
        if(c.session!==prevSess) return <rect key={`s${xi}`} x={x} y={0} width={CWIDTH-x} height={CH} fill={sessColors[c.session]||"#020b16"} opacity={.3}/>;
        return null;
      })}
      {/* Grid */}
      {[0,.2,.4,.6,.8,1].map(f=>{
        const y=pd+f*(CH-pd*2),pv=mx-f*rng;
        return <g key={f}><line x1={0} x2={CWIDTH} y1={y} y2={y} stroke="#071525" strokeWidth={1}/>
          <text x={2} y={y-2} fill="#0d2235" fontSize={7} fontFamily="monospace">{pv.toFixed(0)}</text></g>;
      })}
      {/* PD zones */}
      {pdZones&&<>
        <rect x={0} y={pd} width={CWIDTH} height={(CH-pd*2)*0.3} fill="#f8711508" stroke="#f87115" strokeWidth={.5} strokeDasharray="3,3"/>
        <text x={4} y={pd+10} fill="#f8711560" fontSize={7} fontFamily="monospace">PREMIUM</text>
        <rect x={0} y={pd+(CH-pd*2)*0.7} width={CWIDTH} height={(CH-pd*2)*0.3} fill="#4ade8008" stroke="#4ade80" strokeWidth={.5} strokeDasharray="3,3"/>
        <text x={4} y={pd+(CH-pd*2)*0.99} fill="#4ade8060" fontSize={7} fontFamily="monospace">DISCOUNT</text>
      </>}
      {/* Candles */}
      {vis.map((c,xi)=>{
        const x=xi*(CW+CG)+CW/2,bull=c.close>=c.open;
        const bT=toY(Math.max(c.open,c.close)),bH=Math.max(1,Math.abs(toY(c.open)-toY(c.close)));
        const tr=trMap[c.index+offset];
        const col=tr?.result==="WIN"?"#16a34a":tr?.result==="LOSS"?"#b91c1c":bull?"#0f5132":"#5c1a1a";
        const stroke=tr?.result==="WIN"?"#4ade80":tr?.result==="LOSS"?"#f87171":bull?"#22c55e":"#ef4444";
        return <g key={xi}>
          <line x1={x} x2={x} y1={toY(c.high)} y2={toY(c.low)} stroke={stroke} strokeWidth={.8}/>
          <rect x={x-CW/2} y={bT} width={CW} height={bH} fill={col} rx={1}/>
          {tr&&<rect x={x-CW/2-1} y={bT-1} width={CW+2} height={bH+2} fill="none" stroke={stroke} strokeWidth={1.5} rx={2}/>}
        </g>;
      })}
      {/* Signals */}
      {vSigs.map((s,i)=>{
        const x=(s.index-offset)*(CW+CG)+CW/2;
        if(s.type==="ENTRY") return <g key={i}>
          <line x1={x} x2={CWIDTH} y1={toY(s.price)} y2={toY(s.price)} stroke="#4ade80" strokeWidth={1} strokeDasharray="4,3" opacity={.7}/>
          <line x1={x} x2={CWIDTH} y1={toY(s.sl)}    y2={toY(s.sl)}    stroke="#f87171" strokeWidth={.8} strokeDasharray="3,3" opacity={.6}/>
          <line x1={x} x2={CWIDTH} y1={toY(s.tp)}    y2={toY(s.tp)}    stroke="#38bdf8" strokeWidth={.8} strokeDasharray="3,3" opacity={.6}/>
          <polygon points={`${x},${toY(s.price)+10} ${x-3},${toY(s.price)+3} ${x+3},${toY(s.price)+3}`} fill="#4ade80"/>
          <rect x={x-1} y={toY(s.price)-14} width={s.quality*4+10} height={8} rx={2} fill={["#1e293b","#1d4ed8","#7c3aed","#0f766e","#854d0e","#166534"][Math.min(s.quality,5)]} opacity={.8}/>
        </g>;
        if(s.type==="SWEEP")  return <circle key={i} cx={x} cy={toY(s.price)} r={3} fill="none" stroke="#f97316" strokeWidth={1.2}/>;
        if(s.type==="EQH")    return <g key={i}>{s.levels?.slice(0,2).map((lv,li)=><line key={li} x1={x-10} x2={Math.min(x+40,CWIDTH)} y1={toY(lv)} y2={toY(lv)} stroke="#fbbf24" strokeWidth={.8} strokeDasharray="2,2" opacity={.6}/>)}</g>;
        if(s.type==="DISP")   return <rect key={i} x={x-CW/2} y={toY(candles[s.index]?.high||0)} width={CW} height={Math.max(2,toY(candles[s.index]?.low||0)-toY(candles[s.index]?.high||0))} fill="#7c3aed30" stroke="#7c3aed" strokeWidth={.8}/>;
        if(s.type==="OB")     return <rect key={i} x={x-CW} y={toY(s.high)} width={CW*3} height={Math.max(2,toY(s.low)-toY(s.high))} fill="#1d4ed820" stroke="#1d4ed8" strokeWidth={.8} strokeDasharray="2,2"/>;
        return null;
      })}
    </svg>
  );
}

function EquityCurve({trades,height=70}) {
  const closed=(trades||[]).filter(t=>t.result!=="open");
  if(closed.length<2) return <div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#0d2235",fontSize:9}}>No closed trades yet</div>;
  const W=CWIDTH,pd=6;
  let eq=0,pk=0; const pts=closed.map(t=>{eq+=t.pnl;if(eq>pk)pk=eq;return eq;});
  const mn=Math.min(0,...pts),mx=Math.max(1,...pts),rng=mx-mn||1;
  const toX=i=>(i/(pts.length-1||1))*(W-pd*2)+pd;
  const toY=v=>pd+((mx-v)/rng)*(height-pd*2);
  const path=pts.map((v,i)=>`${i===0?"M":"L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
  const lastC=pts[pts.length-1]>=0?"#4ade80":"#ef4444";
  return (
    <svg width={W} height={height} style={{display:"block",background:"#02080f"}}>
      <polygon points={pts.map((v,i)=>`${toX(i)},${toY(v)}`).join(" ")+` ${toX(pts.length-1)},${height} ${pd},${height}`} fill={pts[pts.length-1]>=0?"#14532d20":"#7f1d1d20"}/>
      <path d={path} fill="none" stroke={lastC} strokeWidth={1.5}/>
      <line x1={pd} x2={W-pd} y1={toY(0)} y2={toY(0)} stroke="#0d2235" strokeWidth={1} strokeDasharray="2,2"/>
      <text x={W-pd-2} y={toY(pts[pts.length-1])-3} fill={lastC} fontSize={8} textAnchor="end" fontFamily="monospace" fontWeight="bold">{pts[pts.length-1]>=0?"+":""}{pts[pts.length-1].toFixed(0)}pts</text>
    </svg>
  );
}

// ════════════════════════════════════════════════════════════════
//  POPULATION GRID
// ════════════════════════════════════════════════════════════════
function PopGrid({population,champion}) {
  const sorted=[...population].sort((a,b)=>(b.fitness||0)-(a.fitness||0));
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:4}}>
      {sorted.map((p,i)=>{
        const isC=p.dna.id===champion?.dna?.id;
        const f=p.fitness;
        const bg=f===null?"#0a1628":f>2?"#0f2e1a":f>0?"#162a0f":f>-2?"#2a1a08":"#2a0a0a";
        const bd=isC?"#fbbf24":f===null?"#0d1f35":f>2?"#22c55e":f>0?"#4ade80":f>-2?"#f97316":"#f87171";
        const fc=f===null?"#1e3a5f":f>2?"#4ade80":f>0?"#86efac":f>-2?"#fb923c":"#f87171";
        return (
          <div key={p.dna.id} style={{background:bg,border:`1px solid ${bd}`,borderRadius:4,padding:"5px 6px",position:"relative",minHeight:60}}>
            {isC&&<div style={{position:"absolute",top:-6,left:"50%",transform:"translateX(-50%)",fontSize:9}}>👑</div>}
            <div style={{fontSize:6,color:"#1e3a5f",fontFamily:"monospace"}}>{p.dna.id}</div>
            <div style={{fontSize:11,fontWeight:900,color:fc,lineHeight:1.1}}>{f!=null?f.toFixed(1):"…"}</div>
            {p.stats&&<>
              <div style={{fontSize:7,color:"#4a6fa5"}}>{(p.stats.winRate*100).toFixed(0)}%WR</div>
              <div style={{fontSize:6,color:"#334155"}}>PF{p.stats.profitFactor.toFixed(1)}</div>
            </>}
            {p.status==="evaluating"&&<div style={{fontSize:6,color:"#60a5fa",animation:"pulse 1s infinite"}}>eval…</div>}
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  KILL ZONE HEATMAP
// ════════════════════════════════════════════════════════════════
function KillZoneHeatmap({kzStats}) {
  if(!kzStats) return <div style={{color:"#0d2235",fontSize:9,padding:8}}>Run backtest to see kill zone data</div>;
  const entries=Object.entries(kzStats).filter(([,v])=>v.total>0);
  if(!entries.length) return <div style={{color:"#0d2235",fontSize:9,padding:8}}>No macro window trades yet</div>;
  const maxPnl=Math.max(...entries.map(([,v])=>Math.abs(v.pnl)),1);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      {entries.sort((a,b)=>b[1].pnl-a[1].pnl).map(([window,v])=>{
        const wr=v.total?v.wins/v.total:0;
        const barW=(Math.abs(v.pnl)/maxPnl)*100;
        const col=v.pnl>0?"#4ade80":"#f87171";
        return (
          <div key={window} style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:90,fontSize:8,color:"#334155",fontFamily:"monospace",flexShrink:0}}>{window}</div>
            <div style={{flex:1,height:14,background:"#071525",borderRadius:3,position:"relative",overflow:"hidden"}}>
              <div style={{width:`${barW}%`,height:"100%",background:col,opacity:.7,borderRadius:3}}/>
            </div>
            <div style={{width:32,fontSize:7,color:col,textAlign:"right"}}>{v.pnl>=0?"+":""}{v.pnl.toFixed(0)}</div>
            <div style={{width:24,fontSize:7,color:"#60a5fa",textAlign:"right"}}>{(wr*100).toFixed(0)}%</div>
            <div style={{width:20,fontSize:7,color:"#1e3a5f",textAlign:"right"}}>{v.total}t</div>
          </div>
        );
      })}
      <div style={{fontSize:7,color:"#071525",marginTop:4}}>Bar = PnL | % = Win rate | t = trades</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  SESSION PERFORMANCE
// ════════════════════════════════════════════════════════════════
function SessionStats({stats}) {
  if(!stats) return null;
  const sessions=[["London 2–8am","london"],["NY Open 9:30–11am","nyOpen"],["NY AM 11am–1pm","nyAM"],["NY PM 1–4pm","nyPM"]];
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
      {sessions.map(([label,key])=>{
        const s=stats[key];
        if(!s) return null;
        const total=s.w+s.l, wr=total?s.w/total:0;
        const col=s.pnl>0?"#4ade80":s.pnl<0?"#f87171":"#334155";
        return (
          <div key={key} style={{background:"#020b16",border:`1px solid ${col}33`,borderRadius:5,padding:"7px 10px"}}>
            <div style={{fontSize:7,color:"#1e3a5f",marginBottom:3}}>{label}</div>
            <div style={{fontSize:12,fontWeight:800,color:col}}>{s.pnl>=0?"+":""}{s.pnl.toFixed(0)}pts</div>
            <div style={{fontSize:8,color:"#334155"}}>{s.w}W / {s.l}L · {(wr*100).toFixed(0)}% WR</div>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  RISK CALCULATOR
// ════════════════════════════════════════════════════════════════
function RiskCalc({champion}) {
  const [balance, setBalance]=useState("10000");
  const [riskPct, setRiskPct]=useState("1");
  const [slPts,   setSlPts]  =useState("30");
  const [pipVal,  setPipVal] =useState("1");

  const riskAmt=+balance*(+riskPct/100);
  const lotSize=slPts>0&&pipVal>0?(riskAmt/(+slPts*+pipVal)).toFixed(2):"—";
  const tp1Pts =champion?.dna?(+slPts*1).toFixed(0):"—";
  const tp2Pts =champion?.dna?(+slPts*(champion.dna.rrRatio||2)).toFixed(0):"—";

  return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
        {[["Account Balance ($)",balance,setBalance],["Risk % per trade",riskPct,setRiskPct],["Stop Loss (pts)",slPts,setSlPts],["Pip Value ($/pt)",pipVal,setPipVal]].map(([l,v,set])=>(
          <div key={l}>
            <div style={{fontSize:7,color:"#1e3a5f",marginBottom:2}}>{l}</div>
            <input value={v} onChange={e=>set(e.target.value)} style={{background:"#020b16",border:"1px solid #071525",color:"#b8cfe8",padding:"4px 7px",borderRadius:4,fontSize:10,fontFamily:"monospace",width:"100%",boxSizing:"border-box"}}/>
          </div>
        ))}
      </div>
      <div style={{background:"#020b16",border:"1px solid #1d4ed855",borderRadius:5,padding:"8px 12px"}}>
        <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
          {[["Risk Amount","$"+riskAmt.toFixed(0),"#f59e0b"],["Lot Size",lotSize+" lots","#4ade80"],["TP1 (1:1)",tp1Pts+" pts","#38bdf8"],["TP2 (1:"+((champion?.dna?.rrRatio||2))+")",tp2Pts+" pts","#60a5fa"]].map(([l,v,c])=>(
            <div key={l}><div style={{fontSize:7,color:"#1e3a5f"}}>{l}</div><div style={{fontSize:13,fontWeight:800,color:c}}>{v}</div></div>
          ))}
        </div>
        <div style={{fontSize:7,color:"#071525",marginTop:6}}>Lot size = Risk Amount ÷ (SL pts × Pip Value). For NAS100 micro: pip value ≈ $0.10/pt per 0.01 lot.</div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  UI HELPERS
// ════════════════════════════════════════════════════════════════
function Card({children,style={}}) { return <div style={{background:"#030d1a",border:"1px solid #071525",borderRadius:6,...style}}>{children}</div>; }
function Stat({l,v,c="#4a6fa5",s,glow}) {
  return <div style={{background:"#020b16",border:`1px solid ${glow?"#fbbf24":"#071525"}`,borderRadius:5,padding:"5px 9px",minWidth:70,boxShadow:glow?"0 0 14px #fbbf2430":"none"}}>
    <div style={{fontSize:7,color:"#0d2235",letterSpacing:1,marginBottom:1}}>{l}</div>
    <div style={{fontSize:13,fontWeight:900,color:c,lineHeight:1}}>{v}</div>
    {s&&<div style={{fontSize:7,color:"#0d2235",marginTop:1}}>{s}</div>}
  </div>;
}
function Btn({onClick,children,bg="#071525",col="#1e5f8a",disabled,sm}) {
  return <button onClick={onClick} disabled={disabled} style={{background:disabled?"#020b16":bg,color:disabled?"#071525":col,border:`1px solid ${disabled?"#071525":col}55`,borderRadius:4,padding:sm?"3px 7px":"5px 11px",fontSize:sm?7:9,fontFamily:"monospace",cursor:disabled?"not-allowed":"pointer",fontWeight:700,letterSpacing:.5}}>{children}</button>;
}
function Tag({label,color="#0d2235",bg="#020b16"}) {
  return <span style={{fontSize:7,color,background:bg,border:`1px solid ${color}44`,borderRadius:3,padding:"1px 5px",fontFamily:"monospace",letterSpacing:.5}}>{label}</span>;
}
function SectionHeader({title}) {
  return <div style={{fontSize:7,color:"#0d2235",fontWeight:900,letterSpacing:2,marginBottom:8,paddingBottom:4,borderBottom:"1px solid #071525"}}>{title}</div>;
}

// ════════════════════════════════════════════════════════════════
//  MAIN APP
// ════════════════════════════════════════════════════════════════
export default function App() {
  // Data
  const [candles,    setCan]     = useState(()=>genCandles(500));
  const [htf15,      setHtf15]   = useState(()=>buildHTF(genCandles(500)));
  const [signals,    setSigs]    = useState([]);
  const [showPD,     setShowPD]  = useState(true);

  // GA
  const [population, setPop]     = useState(()=>Array.from({length:POP_SIZE},()=>({dna:randomDNA(1),stats:null,fitness:null,status:"pending"})));
  const [champion,   setChamp]   = useState(null);
  const [gaGen,      setGAGen]   = useState(1);
  const [gaRunning,  setGARunning]=useState(false);
  const [aiAdvice,   setAI]      = useState(null);
  const [mcResult,   setMC]      = useState(null);

  // Live & data
  const [isLive,     setIsLive]  = useState(false);
  const [dataMode,   setDMode]   = useState("sim");
  const [apiKey,     setApiKey]  = useState(POLYGON_KEY);
  const [ticker,     setTicker]  = useState("I:NDX");
  const [newsBlock,  setNewsBlock]=useState(false);
  const [feedStatus, setFS]      = useState("idle");

  // Telegram
  const [tgToken,    setTgToken] = useState(TG_TOKEN);
  const [tgChat,     setTgChat]  = useState(TG_CHAT);
  const [tgEnabled,  setTgEnabled]=useState(false);
  const [lastTgSig,  setLastTgSig]=useState(null);

  // Notifications / log
  const [log,        setLog]     = useState([]);
  const [alerts,     setAlerts]  = useState([]);

  // UI
  const [offset,     setOffset]  = useState(0);
  const [tab,        setTab]     = useState("pop");
  const [nyTime,     setNYTime]  = useState("--:--:--");
  const [activeMacro,setAM]      = useState(null);
  const [session,    setSession] = useState("overnight");
  const [loaded,     setLoaded]  = useState(false);
  const [autoEv,     setAutoEv]  = useState(false);
  const [killSwitch, setKill]    = useState(false);

  const liveRef=useRef(null), logRef=useRef(null), firedSigs=useRef(new Set());

  const addLog=useCallback((msg,color="#1e5f8a")=>{
    const ts=new Date().toLocaleTimeString("en-US",{hour12:false});
    setLog(l=>[...l.slice(-149),{msg,color,ts}]);
  },[]);

  const addAlert=useCallback((msg,type="info")=>{
    const id=Date.now();
    setAlerts(a=>[{id,msg,type},...a.slice(0,4)]);
    setTimeout(()=>setAlerts(a=>a.filter(x=>x.id!==id)),6000);
  },[]);

  // ── Load saved state ──────────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      const s=await store.load();
      if(s){
        if(s.population) setPop(s.population);
        if(s.champion)   setChamp(s.champion);
        if(s.gaGen)      setGAGen(s.gaGen);
        if(s.log)        setLog(s.log.slice(-60));
        if(s.tgToken)    setTgToken(s.tgToken);
        if(s.tgChat)     setTgChat(s.tgChat);
        if(s.tgEnabled)  setTgEnabled(s.tgEnabled);
        addLog("📂 Session restored","#60a5fa");
      }
      setLoaded(true);
    })();
  },[]);

  // ── Auto save ─────────────────────────────────────────────────
  useEffect(()=>{
    if(!loaded) return;
    store.save({population,champion,gaGen,log:log.slice(-60),tgToken,tgChat,tgEnabled});
  },[population,champion,gaGen,loaded,tgToken,tgChat,tgEnabled]);

  // ── NY clock + session ────────────────────────────────────────
  useEffect(()=>{
    const tick=()=>{
      const p=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(new Date());
      const h=+p.find(x=>x.type==="hour").value, m=+p.find(x=>x.type==="minute").value;
      setNYTime(p.map(x=>x.value).join(""));
      setAM(MACRO_WINDOWS.find(w=>(h>w.s[0]||(h===w.s[0]&&m>=w.s[1]))&&(h<w.e[0]||(h===w.e[0]&&m<w.e[1]))));
      setSession(classifySession(h,m));
    };
    tick(); const id=setInterval(tick,1000); return()=>clearInterval(id);
  },[]);

  // ── Update champion signals + Telegram alerts ─────────────────
  useEffect(()=>{
    if(!champion) return;
    const sigs=runStrategy(candles,champion.dna,htf15);
    setSigs(sigs);
    // Fire Telegram for new entry signals
    if(tgEnabled&&tgToken&&tgChat){
      sigs.filter(s=>s.type==="ENTRY").forEach(s=>{
        const key=`${s.index}`;
        if(!firedSigs.current.has(key)){
          firedSigs.current.add(key);
          const msg=buildSignalMessage(s,champion);
          sendTelegram(tgToken,tgChat,msg).then(ok=>{
            if(ok){ addLog("📲 Telegram alert sent","#4ade80"); addAlert("Signal sent to Telegram!","success"); }
            else addLog("❌ Telegram send failed","#f87171");
          });
          setLastTgSig(s);
        }
      });
    }
    setMC(monteCarlo(champion.stats));
  },[candles,champion,htf15,tgEnabled,tgToken,tgChat]);

  // ── Evaluate one organism ─────────────────────────────────────
  const evalOrganism=useCallback((idx,pop,cands)=>{
    const org=pop[idx]; if(!org||org.status==="done") return pop;
    const stats=backtest(cands,org.dna,htf15);
    const fitness=fitnessScore(stats);
    const updated=[...pop]; updated[idx]={...org,stats,fitness,status:"done"};
    return updated;
  },[htf15]);

  // ── Run GA generation ─────────────────────────────────────────
  const runGeneration=useCallback(async(pop,cands,gen)=>{
    setGARunning(true);
    addLog(`🧬 Gen ${gen} — evaluating ${POP_SIZE} organisms…`,"#a78bfa");
    let cur=[...pop];
    for(let i=0;i<cur.length;i++){
      if(cur[i].status!=="done"){
        setPop(p=>{const u=[...p];u[i]={...u[i],status:"evaluating"};return u;});
        await new Promise(r=>setTimeout(r,25));
        cur=evalOrganism(i,cur,cands);
        setPop([...cur]);
      }
    }
    const ranked=[...cur].sort((a,b)=>(b.fitness||0)-(a.fitness||0));
    const newChamp=ranked[0];
    setChamp(newChamp);
    addLog(`👑 Champion: ${newChamp.dna.id} fitness=${newChamp.fitness?.toFixed(2)} WR=${((newChamp.stats?.winRate||0)*100).toFixed(0)}% PF=${newChamp.stats?.profitFactor?.toFixed(2)}`,"#fbbf24");
    addAlert(`Gen ${gen} done — Champ fitness ${newChamp.fitness?.toFixed(1)}`,"success");

    if(newChamp.stats?.maxCL>=5&&!killSwitch){ setKill(true); addLog("🛑 KILL SWITCH: 5+ consecutive losses","#f87171"); }

    let forceMutate=[];
    try {
      const advice=await claudeAdvise(newChamp,cur,gen);
      setAI(advice);
      forceMutate=advice.forceMutateGenes||[];
      addLog(`🤖 ${advice.insight}`,"#60a5fa");
      addLog(`💡 ${advice.recommend} [session: ${advice.sessionAdvice}]`,"#38bdf8");
    } catch(e){ addLog(`AI failed: ${e.message}`,"#f87171"); }

    const next=nextGeneration(cur,gen+1,forceMutate);
    setPop(next); setGAGen(gen+1); setGARunning(false);
    addLog(`✅ Gen ${gen} complete → Gen ${gen+1} spawned`,"#4ade80");
  },[evalOrganism,addLog,addAlert,killSwitch]);

  // ── Live feed ─────────────────────────────────────────────────
  useEffect(()=>{
    if(!isLive){clearInterval(liveRef.current);return;}
    liveRef.current=setInterval(async()=>{
      if(dataMode==="polygon"&&apiKey){
        try {
          const live=await fetchPolygon(ticker,apiKey,3);
          setCan(live); setHtf15(buildHTF(live)); setFS("live");
          const news=await checkNewsBlock(apiKey);
          setNewsBlock(news);
          if(news) addLog("📰 NEWS BLOCK active","#f87171");
        } catch(e){ addLog(`Polygon: ${e.message}`,"#f87171"); setFS("error"); }
      } else {
        setCan(prev=>{
          const last=prev[prev.length-1];
          const v=10+Math.random()*50,b=Math.random()>.5?-1:1;
          const o=last.close,cl=o+b*Math.random()*v*.68;
          const h=Math.max(o,cl)+Math.random()*v*.3,l=Math.min(o,cl)-Math.random()*v*.3;
          const next=[...prev.slice(-600),{open:o,close:cl,high:h,low:l,index:prev.length,ts:Date.now(),volume:Math.floor(500+Math.random()*3500),session}];
          setHtf15(buildHTF(next)); return next;
        });
        setOffset(o=>Math.max(0,o+1)); setFS("sim");
      }
    },700);
    return()=>clearInterval(liveRef.current);
  },[isLive,dataMode,apiKey,ticker,session]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[log]);
  useEffect(()=>{ if(autoEv&&!gaRunning&&population.filter(p=>p.status==="done").length===POP_SIZE) runGeneration(population,candles,gaGen); },[autoEv,gaRunning,population,candles,gaGen]);

  const newMarket=()=>{
    const nc=genCandles(500,Math.random()*9999);
    setCan(nc); setHtf15(buildHTF(nc)); setOffset(0); setKill(false); firedSigs.current=new Set();
    setPop(p=>p.map(o=>({...o,status:"pending",stats:null,fitness:null})));
    addLog("↺ New market — population reset","#60a5fa");
  };
  const hardReset=async()=>{
    await store.clear();
    const nc=genCandles(500); setCan(nc); setHtf15(buildHTF(nc));
    setPop(Array.from({length:POP_SIZE},()=>({dna:randomDNA(1),stats:null,fitness:null,status:"pending"})));
    setChamp(null); setGAGen(1); setLog([]); setAI(null); setKill(false); firedSigs.current=new Set();
    addLog("🗑 Hard reset","#f87171");
  };

  const ch=champion; const cs=ch?.stats;
  const wrC=cs?(cs.winRate>=.55?"#4ade80":cs.winRate>=.44?"#f59e0b":"#f87171"):"#0d2235";
  const pfC=cs?(cs.profitFactor>=1.2?"#4ade80":cs.profitFactor>=.8?"#f59e0b":"#f87171"):"#0d2235";
  const doneCount=population.filter(p=>p.status==="done").length;
  const sessColor={london:"#1e3a8a",nyOpen:"#14532d",nyAM:"#1a2e0f",nyPM:"#3b1f08",overnight:"#1a1a2d"}[session]||"#1a1a2d";

  const TABS=[["pop","🧬 Pop"],["chart","📈 Chart"],["kz","🎯 Kill Zones"],["session","🕐 Sessions"],["journal","📋 Journal"],["mc","🎲 Monte Carlo"],["genes","🔬 Genes"],["risk","💰 Risk"],["feed","🔌 Feed"],["tg","📲 Alerts"]];

  return (
    <div style={{background:"#01060f",minHeight:"100vh",color:"#b8cfe8",fontFamily:"'JetBrains Mono','Courier New',monospace",padding:"10px 12px",maxWidth:720,margin:"0 auto"}}>

      {/* ── FLOATING ALERTS ── */}
      <div style={{position:"fixed",top:10,right:10,zIndex:999,display:"flex",flexDirection:"column",gap:5}}>
        {alerts.map(a=>(
          <div key={a.id} style={{background:a.type==="success"?"#0f2e1a":"#2a0a0a",border:`1px solid ${a.type==="success"?"#4ade80":"#f87171"}`,borderRadius:5,padding:"6px 12px",fontSize:9,color:a.type==="success"?"#4ade80":"#f87171",maxWidth:240,animation:"slideIn .3s ease"}}>
            {a.msg}
          </div>
        ))}
      </div>

      {/* ── HEADER ── */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,flexWrap:"wrap",gap:6}}>
        <div>
          <div style={{fontSize:14,fontWeight:900,letterSpacing:5,color:"#e8f0f8",textTransform:"uppercase"}}>◈ ONE LIFE v{VERSION}</div>
          <div style={{fontSize:7,color:"#0d2235",letterSpacing:2,marginTop:1}}>FULL ICT SYSTEM · GA {POP_SIZE} ORGANISMS · GEN {gaGen}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,fontWeight:700,color:activeMacro?"#4ade80":"#0d2235"}}>🕐 {nyTime} NY</div>
          <div style={{background:sessColor,borderRadius:3,padding:"1px 6px",fontSize:7,color:"#b8cfe8",marginTop:2,display:"inline-block"}}>{session.toUpperCase()}</div>
          {activeMacro&&<div style={{fontSize:7,color:"#4ade80",marginTop:1}}>⚡ {activeMacro.l}</div>}
        </div>
      </div>

      {/* ── BANNERS ── */}
      {newsBlock&&<div style={{background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:4,padding:"5px 10px",marginBottom:6,fontSize:9,color:"#f87171",fontWeight:700}}>📰 HIGH-IMPACT NEWS — TRADING BLOCKED</div>}
      {killSwitch&&<div style={{background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:4,padding:"5px 10px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:9,color:"#f87171",fontWeight:700}}>🛑 KILL SWITCH — {cs?.maxCL} consecutive losses</span>
        <Btn onClick={()=>setKill(false)} col="#f87171" bg="#3b0f0f" sm>Override</Btn>
      </div>}
      {gaRunning&&<div style={{marginBottom:6}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}><span style={{fontSize:8,color:"#a78bfa"}}>🧬 EVALUATING…</span><span style={{fontSize:8,color:"#4ade80"}}>{doneCount}/{POP_SIZE}</span></div>
        <div style={{height:3,background:"#071525",borderRadius:2}}><div style={{height:3,width:`${(doneCount/POP_SIZE)*100}%`,background:"linear-gradient(90deg,#7c3aed,#4ade80)",borderRadius:2,transition:"width .3s"}}/></div>
      </div>}
      {aiAdvice&&<div style={{background:"#030d1a",border:"1px solid #1e3a5f",borderRadius:4,padding:"6px 10px",marginBottom:6}}>
        <div style={{fontSize:7,color:"#1e5f8a",fontWeight:700,marginBottom:2}}>🤖 AI INSIGHT — {aiAdvice.confidence}/10 confidence</div>
        <div style={{fontSize:8,color:"#60a5fa",lineHeight:1.5}}>{aiAdvice.insight}</div>
        <div style={{fontSize:7,color:"#38bdf8",marginTop:2}}>→ {aiAdvice.recommend}</div>
        {aiAdvice.sessionAdvice&&<div style={{fontSize:7,color:"#fbbf24",marginTop:1}}>Focus: {aiAdvice.sessionAdvice}</div>}
      </div>}

      {/* ── STATS ── */}
      <div style={{display:"flex",gap:5,marginBottom:10,flexWrap:"wrap"}}>
        <Stat l="CHAMPION"   v={ch?ch.dna.id:"—"}                       c="#fbbf24" s={ch?`G${ch.dna.generation}`:undefined} glow={!!ch}/>
        <Stat l="FITNESS"    v={ch?(ch.fitness||0).toFixed(2):"—"}       c="#a78bfa"/>
        <Stat l="WIN RATE"   v={cs?((cs.winRate*100).toFixed(0)+"%"):"—"} c={wrC} s={cs?`${cs.wins}W/${cs.losses}L`:undefined}/>
        <Stat l="PROF FACTOR" v={cs?cs.profitFactor.toFixed(2):"—"}      c={pfC}/>
        <Stat l="MAX DD"     v={cs?(cs.maxDD.toFixed(0)+"pts"):"—"}       c={cs?.maxDD>200?"#f87171":cs?.maxDD>80?"#f59e0b":"#4ade80"}/>
        <Stat l="SHARPE"     v={cs?cs.sharpe.toFixed(2):"—"}              c={cs?.sharpe>0.5?"#4ade80":cs?.sharpe>0?"#f59e0b":"#f87171"}/>
        <Stat l="TRADES"     v={cs?cs.total:"—"}                          c="#38bdf8"/>
        <Stat l="GEN"        v={`G${gaGen}`}                              c="#60a5fa" s={`${doneCount}/${POP_SIZE} done`}/>
      </div>

      {/* ── TABS ── */}
      <div style={{display:"flex",borderBottom:"1px solid #071525",marginBottom:0,overflowX:"auto",flexWrap:"nowrap"}}>
        {TABS.map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:"transparent",border:"none",borderBottom:`2px solid ${tab===id?"#4ade80":"transparent"}`,color:tab===id?"#4ade80":"#0d2235",padding:"5px 9px",fontSize:8,fontFamily:"monospace",cursor:"pointer",fontWeight:tab===id?800:400,letterSpacing:.5,whiteSpace:"nowrap"}}>{lbl}</button>
        ))}
      </div>

      {/* ── TAB: POPULATION ── */}
      {tab==="pop"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title={`FITNESS LANDSCAPE — GEN ${gaGen} — ${doneCount}/${POP_SIZE} EVALUATED`}/>
        <PopGrid population={population} champion={champion}/>
        <div style={{marginTop:6,display:"flex",gap:8,fontSize:7,color:"#0d2235",flexWrap:"wrap"}}>
          <span style={{color:"#22c55e"}}>■ &gt;2</span><span style={{color:"#4ade80"}}>■ &gt;0</span><span style={{color:"#f97316"}}>■ &gt;-2</span><span style={{color:"#f87171"}}>■ failing</span>
          <span style={{marginLeft:"auto",color:"#071525"}}>Fitness = 2×PF + 3×WR + 1.5×Sharpe − DDpenalty − CLpenalty</span>
        </div>
      </Card>}

      {/* ── TAB: CHART ── */}
      {tab==="chart"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",marginBottom:10,overflow:"hidden"}}>
        <div style={{padding:"4px 10px",borderBottom:"1px solid #071525",display:"flex",gap:8,fontSize:7,color:"#0d2235",flexWrap:"wrap",alignItems:"center"}}>
          <span style={{color:"#f97316"}}>● Sweep</span><span style={{color:"#7c3aed"}}>■ OB</span>
          <span style={{color:"#fbbf24"}}>— EqHigh</span><span style={{color:"#7c3aed"}}>■ Disp</span>
          <span style={{color:"#4ade80"}}>▲ Entry</span><span style={{color:"#22c55e"}}>■ Win</span><span style={{color:"#ef4444"}}>■ Loss</span>
          <label style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
            <input type="checkbox" checked={showPD} onChange={e=>setShowPD(e.target.checked)} style={{accentColor:"#4ade80"}}/>
            <span style={{color:"#334155"}}>PD zones</span>
          </label>
        </div>
        {champion
          ?<><div style={{overflowX:"auto"}}><PriceChart candles={candles} signals={signals} offset={offset} trades={cs?.trades} pdZones={showPD}/></div>
          <div style={{borderTop:"1px solid #071525"}}><EquityCurve trades={cs?.trades}/></div>
          <div style={{display:"flex",gap:4,padding:"5px 8px",borderTop:"1px solid #071525"}}>
            {["◀◀","◀","▶","▶▶"].map((l,i)=>(
              <Btn key={i} sm onClick={()=>setOffset(o=>[0,Math.max(0,o-1),Math.min(candles.length-CVIS,o+1),Math.max(0,candles.length-CVIS)][i])}>{l}</Btn>
            ))}
            <span style={{fontSize:7,color:"#0d2235",alignSelf:"center",marginLeft:4}}>{offset+1}–{Math.min(offset+CVIS,candles.length)}/{candles.length}</span>
          </div></>
          :<div style={{padding:20,textAlign:"center",color:"#0d2235",fontSize:9}}>Run GA to elect a champion first</div>}
      </Card>}

      {/* ── TAB: KILL ZONES ── */}
      {tab==="kz"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title="KILL ZONE HEATMAP — PNL BY MACRO WINDOW"/>
        <KillZoneHeatmap kzStats={cs?.kzStats}/>
        <div style={{marginTop:10,fontSize:8,color:"#0d2235",lineHeight:1.8}}>
          Green bars = profitable macro windows. Focus your attention on the top 2–3 windows and ignore the rest. ICT practitioners find 9:50–10:10 and 2:50–3:10 consistently strongest.
        </div>
      </Card>}

      {/* ── TAB: SESSIONS ── */}
      {tab==="session"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title="SESSION PERFORMANCE"/>
        <SessionStats stats={cs?.sessionStats}/>
        <div style={{marginTop:10}}>
          <SectionHeader title="CURRENT SPREAD/SLIP ENVIRONMENT"/>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {Object.entries(SESSION_SPREAD).map(([s,sp])=>(
              <div key={s} style={{background:s===session?"#0f2e1a":"#020b16",border:`1px solid ${s===session?"#4ade80":"#071525"}`,borderRadius:4,padding:"5px 9px"}}>
                <div style={{fontSize:7,color:"#1e3a5f"}}>{s}</div>
                <div style={{fontSize:10,color:"#b8cfe8"}}>{sp}pt spread · {SESSION_SLIP[s]}pt slip</div>
              </div>
            ))}
          </div>
        </div>
      </Card>}

      {/* ── TAB: JOURNAL ── */}
      {tab==="journal"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",marginBottom:10,overflow:"hidden"}}>
        <div style={{padding:"6px 10px",borderBottom:"1px solid #071525",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <SectionHeader title={`TRADE JOURNAL — ${cs?.total||0} TRADES`}/>
          <div style={{display:"flex",gap:"6"}}>
            <Tag label={`${cs?.wins||0}W`} color="#4ade80"/>
            <Tag label={`${cs?.losses||0}L`} color="#f87171"/>
            <Tag label={`${cs?.totalPnl>=0?"+":""}${cs?.totalPnl?.toFixed(0)||0}pts`} color={cs?.totalPnl>=0?"#4ade80":"#f87171"}/>
          </div>
        </div>
        <div style={{maxHeight:320,overflowY:"auto"}}>
          <div style={{display:"flex",gap:8,padding:"4px 8px",fontSize:7,color:"#071525",borderBottom:"1px solid #071525"}}>
            <span style={{minWidth:20}}>#</span><span style={{minWidth:40}}>Result</span><span style={{minWidth:60}}>Entry</span><span style={{minWidth:60}}>PnL</span><span style={{minWidth:50}}>Session</span><span>Confirms</span>
          </div>
          {(cs?.trades||[]).filter(t=>t.result!=="open").slice().reverse().map((t,i)=><JournalRow key={i} trade={t} i={i}/>)}
          {(!cs?.trades||cs.trades.length===0)&&<div style={{padding:16,color:"#0d2235",fontSize:9,textAlign:"center"}}>No trades yet — run GA generation first</div>}
        </div>
      </Card>}

      {/* ── TAB: MONTE CARLO ── */}
      {tab==="mc"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title="MONTE CARLO — 300 RUNS (SHUFFLED TRADE ORDER)"/>
        {mcResult?<>
          <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:10}}>
            {[["5th pctile",mcResult.p5.toFixed(0)+"pts",mcResult.p5>=0?"#4ade80":"#f87171"],
              ["Median",mcResult.median.toFixed(0)+"pts",mcResult.median>=0?"#4ade80":"#f87171"],
              ["95th pctile",mcResult.p95.toFixed(0)+"pts","#4ade80"],
              ["Worst DD",mcResult.worstDD.toFixed(0)+"pts","#f87171"],
              ["Ruin prob",(mcResult.ruin*100).toFixed(1)+"%",mcResult.ruin<.05?"#4ade80":mcResult.ruin<.15?"#f59e0b":"#f87171"]
            ].map(([l,v,c])=>(<div key={l} style={{background:"#020b16",border:"1px solid #071525",borderRadius:4,padding:"5px 9px"}}><div style={{fontSize:7,color:"#0d2235"}}>{l}</div><div style={{fontSize:12,fontWeight:800,color:c}}>{v}</div></div>))}
          </div>
          {mcResult.ruin>0.15&&<div style={{background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:4,padding:"6px 10px",fontSize:8,color:"#f87171"}}>⚠ Ruin probability &gt;15% — reduce lot size significantly before live trading</div>}
          {mcResult.ruin<=0.05&&<div style={{background:"#0f2e1a",border:"1px solid #166534",borderRadius:4,padding:"6px 10px",fontSize:8,color:"#4ade80"}}>✅ Ruin probability acceptable — strategy has positive robustness</div>}
        </>:<div style={{color:"#0d2235",fontSize:9}}>Need {MIN_TRADES}+ closed trades. Run GA first.</div>}
      </Card>}

      {/* ── TAB: GENES ── */}
      {tab==="genes"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title="GENE DISTRIBUTION ACROSS POPULATION"/>
        {Object.keys(GENE_RANGES).map(gene=>{
          const [mn,mx]=GENE_RANGES[gene];
          const vals=population.filter(p=>p.dna).map(p=>p.dna[gene]);
          const avg=vals.reduce((a,b)=>a+b,0)/vals.length;
          const champVal=ch?.dna?.[gene];
          const pct=(avg-mn)/(mx-mn);
          const cPct=champVal!=null?(champVal-mn)/(mx-mn):null;
          return (
            <div key={gene} style={{marginBottom:7}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                <span style={{fontSize:7,color:"#1e3a5f"}}>{gene}</span>
                <div style={{display:"flex",gap:10}}>
                  <span style={{fontSize:7,color:"#334155"}}>avg {typeof avg==="number"?avg.toFixed(avg%1?3:1):"?"}</span>
                  {champVal!=null&&<span style={{fontSize:7,color:"#fbbf24"}}>👑 {typeof champVal==="number"?champVal.toFixed(champVal%1?3:1):"?"}</span>}
                </div>
              </div>
              <div style={{height:7,background:"#071525",borderRadius:3,position:"relative"}}>
                {vals.map((v,i)=>{ const p=(v-mn)/(mx-mn); return <div key={i} style={{position:"absolute",top:0,left:`${p*100}%`,width:2,height:7,background:"#1e3a5f",borderRadius:1}}/>; })}
                <div style={{position:"absolute",top:-1,left:`${pct*100}%`,width:2,height:9,background:"#60a5fa",borderRadius:1}}/>
                {cPct!=null&&<div style={{position:"absolute",top:-2,left:`${cPct*100}%`,width:3,height:11,background:"#fbbf24",borderRadius:1}}/>}
              </div>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:1}}>
                <span style={{fontSize:6,color:"#071525"}}>{mn}</span><span style={{fontSize:6,color:"#071525"}}>{mx}</span>
              </div>
            </div>
          );
        })}
        <div style={{fontSize:7,color:"#0d2235",marginTop:4}}><span style={{color:"#60a5fa"}}>━ avg</span> &nbsp; <span style={{color:"#fbbf24"}}>━ champion</span> &nbsp; <span style={{color:"#1e3a5f"}}>| each organism</span></div>
      </Card>}

      {/* ── TAB: RISK CALCULATOR ── */}
      {tab==="risk"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title="POSITION SIZE CALCULATOR"/>
        <RiskCalc champion={champion}/>
        <div style={{marginTop:10}}>
          <SectionHeader title="CHAMPION DNA SUMMARY"/>
          {ch?<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5}}>
            {Object.entries(ch.dna).filter(([k])=>GENE_RANGES[k]).map(([k,v])=>(
              <div key={k} style={{background:"#020b16",border:"1px solid #071525",borderRadius:4,padding:"4px 7px"}}>
                <div style={{fontSize:6,color:"#0d2235"}}>{k}</div>
                <div style={{fontSize:10,fontWeight:700,color:"#b8cfe8"}}>{typeof v==="number"?v.toFixed(v%1?3:0):String(v)}</div>
              </div>
            ))}
          </div>:<div style={{color:"#0d2235",fontSize:9}}>Run GA to see champion DNA</div>}
        </div>
      </Card>}

      {/* ── TAB: FEED ── */}
      {tab==="feed"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title="DATA PIPELINE"/>
        <div style={{display:"flex",gap:5,marginBottom:10}}>
          {[["sim","🔵 Simulated"],["polygon","🟢 Polygon.io"]].map(([id,lbl])=>(
            <div key={id} onClick={()=>setDMode(id)} style={{padding:"5px 11px",borderRadius:4,fontSize:9,cursor:"pointer",fontWeight:700,background:dataMode===id?"#071525":"#020b16",border:`1px solid ${dataMode===id?"#1e5f8a":"#071525"}`,color:dataMode===id?"#b8cfe8":"#0d2235"}}>{lbl}</div>
          ))}
          <Tag label={feedStatus==="live"?"● LIVE":feedStatus==="sim"?"● SIM":feedStatus==="error"?"● ERR":"● IDLE"} color={feedStatus==="live"?"#4ade80":feedStatus==="error"?"#f87171":"#334155"}/>
        </div>
        {dataMode==="polygon"&&<div style={{display:"flex",flexDirection:"column",gap:6}}>
          <div>
            <div style={{fontSize:7,color:"#0d2235",marginBottom:2}}>POLYGON.IO API KEY</div>
            <input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk_…" style={{background:"#020b16",border:"1px solid #071525",color:"#b8cfe8",padding:"4px 8px",borderRadius:4,fontSize:9,fontFamily:"monospace",width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:7,color:"#0d2235",marginBottom:2}}>TICKER</div>
            <input value={ticker} onChange={e=>setTicker(e.target.value)} style={{background:"#020b16",border:"1px solid #071525",color:"#b8cfe8",padding:"4px 8px",borderRadius:4,fontSize:9,fontFamily:"monospace",width:130}}/>
          </div>
          <div style={{fontSize:7,color:"#071525",lineHeight:1.8}}>Free tier: 5 req/min, 15-min delayed. Real-time needs paid plan.<br/>News filter auto-blocks FOMC, CPI, NFP, GDP events.</div>
        </div>}
        {dataMode==="sim"&&<div style={{background:"#020b16",border:"1px solid #071525",borderRadius:4,padding:"8px 10px",fontSize:8,color:"#0d2235",lineHeight:1.8}}>
          500 bars · Regime-aware trends · Session-stamped candles · HTF 15-min auto-built · Spread + slippage vary by session
        </div>}
      </Card>}

      {/* ── TAB: TELEGRAM ── */}
      {tab==="tg"&&<Card style={{borderTop:"none",borderRadius:"0 0 6px 6px",padding:10,marginBottom:10}}>
        <SectionHeader title="TELEGRAM SIGNAL ALERTS"/>
        <div style={{display:"flex",flexDirection:"column",gap:7}}>
          <div>
            <div style={{fontSize:7,color:"#0d2235",marginBottom:2}}>BOT TOKEN (from @BotFather)</div>
            <input type="password" value={tgToken} onChange={e=>setTgToken(e.target.value)} placeholder="123456:ABC-DEF…" style={{background:"#020b16",border:"1px solid #071525",color:"#b8cfe8",padding:"4px 8px",borderRadius:4,fontSize:9,fontFamily:"monospace",width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:7,color:"#0d2235",marginBottom:2}}>CHAT ID (from @userinfobot)</div>
            <input value={tgChat} onChange={e=>setTgChat(e.target.value)} placeholder="-100123456789" style={{background:"#020b16",border:"1px solid #071525",color:"#b8cfe8",padding:"4px 8px",borderRadius:4,fontSize:9,fontFamily:"monospace",width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div onClick={()=>setTgEnabled(!tgEnabled)} style={{width:30,height:16,borderRadius:8,background:tgEnabled?"#0f2e1a":"#071525",border:`1px solid ${tgEnabled?"#4ade80":"#1e3a5f"}`,cursor:"pointer",position:"relative"}}>
              <div style={{position:"absolute",top:2,left:tgEnabled?14:2,width:10,height:10,borderRadius:"50%",background:tgEnabled?"#4ade80":"#1e3a5f",transition:"left .2s"}}/>
            </div>
            <span style={{fontSize:9,color:tgEnabled?"#4ade80":"#0d2235"}}>Send alerts when signal fires</span>
          </div>
          <Btn onClick={()=>sendTelegram(tgToken,tgChat,"✅ One Life Bot connected successfully!").then(ok=>addAlert(ok?"Telegram test sent!":"Telegram failed — check token/chat ID",ok?"success":"error"))} disabled={!tgToken||!tgChat} col="#4ade80" bg="#0f2e1a">
            📲 Send Test Message
          </Btn>
          {lastTgSig&&<div style={{background:"#020b16",border:"1px solid #166534",borderRadius:4,padding:"6px 8px",fontSize:8,color:"#4ade80"}}>Last signal sent: Entry @{lastTgSig.price?.toFixed(0)} · {lastTgSig.confirms?.join(",")} · Q{lastTgSig.quality}</div>}
          <div style={{fontSize:7,color:"#071525",lineHeight:1.9}}>
            Setup: 1) Message @BotFather → /newbot → copy token<br/>
            2) Message @userinfobot → copy your chat ID<br/>
            3) Paste both above and enable alerts<br/>
            Every new SHORT signal fires a detailed Telegram message with entry, SL, TP, confirms, session, and PD array level.
          </div>
        </div>
      </Card>}

      {/* ── CONTROLS ── */}
      <div style={{display:"flex",gap:5,marginBottom:8,flexWrap:"wrap",alignItems:"center"}}>
        <Btn onClick={()=>runGeneration(population,candles,gaGen)} disabled={gaRunning} bg="#0a0a2e" col="#a78bfa">
          {gaRunning?"⏳ Running…":"🧬 Run Gen"}
        </Btn>
        <Btn onClick={()=>{setIsLive(!isLive);addLog(isLive?"⏹ Stopped":"▶ Live started",isLive?"#f87171":"#4ade80");}} bg={isLive?"#1a0505":"#051a0a"} col={isLive?"#f87171":"#4ade80"}>
          {isLive?"⏹ Stop":"▶ Live"}
        </Btn>
        <Btn onClick={newMarket} col="#38bdf8">↺ New Market</Btn>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <div onClick={()=>setAutoEv(!autoEv)} style={{width:26,height:14,borderRadius:7,background:autoEv?"#0f2e1a":"#071525",border:`1px solid ${autoEv?"#4ade80":"#1e3a5f"}`,cursor:"pointer",position:"relative"}}>
            <div style={{position:"absolute",top:2,left:autoEv?12:2,width:8,height:8,borderRadius:"50%",background:autoEv?"#4ade80":"#1e3a5f",transition:"left .2s"}}/>
          </div>
          <span style={{fontSize:8,color:autoEv?"#4ade80":"#0d2235"}}>Auto-evolve</span>
        </div>
        <Btn onClick={hardReset} col="#f87171" bg="#020b16">🗑 Reset</Btn>
      </div>

      {/* ── LOG ── */}
      <Card>
        <div style={{padding:"4px 10px",borderBottom:"1px solid #071525",fontSize:7,color:"#0d2235",fontWeight:700,letterSpacing:1}}>SYSTEM LOG</div>
        <div ref={logRef} style={{height:100,overflowY:"auto",padding:"4px 10px"}}>
          {!log.length&&<div style={{color:"#071525",fontSize:9,paddingTop:6}}>Ready. Press Run Gen to start genetic evolution.</div>}
          {log.map((l,i)=>(<div key={i} style={{fontSize:8,color:l.color,marginBottom:1,display:"flex",gap:8}}><span style={{color:"#071525",flexShrink:0}}>{l.ts}</span><span>{l.msg}</span></div>))}
        </div>
      </Card>

      <div style={{marginTop:5,fontSize:6,color:"#010810"}}>v{VERSION} · Educational only · Not financial advice · Demo account first</div>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
      `}</style>
    </div>
  );
}
