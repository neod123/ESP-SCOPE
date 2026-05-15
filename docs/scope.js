'use strict';

/* ═══════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════ */
const H_DIV        = 10;
const V_DIV        = 8;
const DISP_PTS     = 800;    // display resolution (points returned to Chart.js)
const BUF_PTS      = 60000;  // ring buffer depth (~60s at 1000 samples/sec)
const ADC_MIDSCALE = 2048;   // 12-bit ADC center = 0V reference

// Fixed Y half-range in raw ADC units (full ADC range, no scale slider).
const Y_HALFRANGE = 2048;

const CH_DEFS = [
  { id: 1, color: '#00e87a' },
  { id: 2, color: '#ff4060' },
  { id: 3, color: '#3ab8ff' },
  { id: 4, color: '#ffb020' },
];

const CH_WAVES = {
  1: { freq: 2.5,  amp: 900, ampVar: 200, varFreq: 0.12, phase: 0.0 },
  2: { freq: 6.0,  amp: 650, ampVar: 250, varFreq: 0.09, phase: 1.4 },
  3: { freq: 11.0, amp: 400, ampVar: 300, varFreq: 0.17, phase: 2.6 },
  4: { freq: 1.8,  amp: 750, ampVar: 150, varFreq: 0.07, phase: 0.8 },
};

/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
const state = {};
CH_DEFS.forEach(d => {
  state[d.id] = {
    color:        d.color,
    offset:       0,        // vertical shift in raw ADC units
    units:        '',
    triggerEdge:  'NONE',
    triggerLevel: 0,        // relative to (ADC_MIDSCALE + offset)
    visible:      true,
    a:            1,        // formula: display = a * raw + b
    b:            0,
  };
});

let tbMs      = 100;
let trigPosMs = 100;
let running   = false;
let simMode   = true;       // demo mode: simulate sinusoidal signals

let trigArmed       = false; // true once the arm delay has elapsed
let trigFired       = false; // set by checkTrigger; consumed in frame()
let trigArmDeadline = 0;    // performance.now() timestamp when trigger detection activates
const prevRaw = {};         // last raw ADC sample per channel for edge detection
CH_DEFS.forEach(d => { prevRaw[d.id] = ADC_MIDSCALE; });

const totalMs = () => tbMs * H_DIV;

/* ═══════════════════════════════════════════════════
   RING BUFFER
   ring[ch]   — raw ADC values 0-4095
   ringTs[ch] — µs timestamp of each sample (ESP32 micros() or sim equivalent)
   X positions in readRing are derived from real timestamps so that the
   displayed width of a pulse correctly matches the timebase setting.
═══════════════════════════════════════════════════ */
const ring   = {};
const ringTs = {};
const wHead  = {};
CH_DEFS.forEach(d => {
  ring[d.id]   = new Float32Array(BUF_PTS);
  ringTs[d.id] = new Float64Array(BUF_PTS);  // µs; Float64 holds uint32 exactly
  wHead[d.id]  = 0;
});

function clearBuffers() {
  CH_DEFS.forEach(d => {
    ring[d.id].fill(ADC_MIDSCALE);
    ringTs[d.id].fill(0);
    wHead[d.id] = 0;
  });
}

// Returns up to DISP_PTS {x,y} points covering [0, totalMs()].
// Scans from newest to oldest → exits early for small timebases.
// Buckets the window into DISP_PTS slots and keeps one sample per slot.
function readRing(ch) {
  const raw      = ring[ch];
  const ts       = ringTs[ch];
  const h        = wHead[ch];
  const winUs    = totalMs() * 1000;           // visible window in µs
  const latestTs = ts[(h + BUF_PTS - 1) % BUF_PTS];
  if (latestTs === 0) return [];               // buffer not yet populated

  const startTs  = latestTs - winUs;
  const bucketUs = winUs / DISP_PTS;
  const slots    = new Array(DISP_PTS).fill(null);

  // Scan newest → oldest; break as soon as we pass the window start
  for (let i = BUF_PTS - 1; i >= 0; i--) {
    const idx = (h + i) % BUF_PTS;
    const t   = ts[idx];
    if (t === 0) break;           // uninitialized tail
    if (t < startTs) break;       // before visible window (monotonic → safe to stop)
    const bucket = Math.floor((t - startTs) / bucketUs);
    if (bucket >= 0 && bucket < DISP_PTS && slots[bucket] === null) {
      slots[bucket] = { x: (t - latestTs) / 1000 + totalMs(), y: raw[idx] };
    }
  }
  return slots.filter(p => p !== null);
}

/* ═══════════════════════════════════════════════════
   CONVERT
   Applied to raw ADC values when displaying axis tick labels.
   Default: identity (raw ADC integer).
   Example: a = 3.3/4096, b = 0  →  ticks in Volts
═══════════════════════════════════════════════════ */
function convert(ch, raw) {
  const { a, b } = state[ch];
  return a * raw + b;
}


/* ═══════════════════════════════════════════════════
   SIMULATION
   Generates raw ADC values in 0-4095 centred around ADC_MIDSCALE.
═══════════════════════════════════════════════════ */
let simT = 0;

function simSample(ch, t) {
  const w   = CH_WAVES[ch];
  const amp = w.amp + w.ampVar * Math.sin(2 * Math.PI * w.varFreq * t + w.phase);
  const v   = ADC_MIDSCALE + amp * Math.sin(2 * Math.PI * w.freq * t) + (Math.random() - 0.5) * 40;
  return Math.max(0, Math.min(4095, v));
}

/* Returns true when ch crosses its trigger threshold (sets trigFired). */
function checkTrigger(ch, raw) {
  const s     = state[ch];
  const prev  = prevRaw[ch];
  prevRaw[ch] = raw;
  if (!trigArmed || s.triggerEdge === 'NONE') return false;
  const thr = ADC_MIDSCALE + s.triggerLevel;
  if ((s.triggerEdge === 'RISING'  || s.triggerEdge === 'BOTH') && prev < thr && raw >= thr) return true;
  if ((s.triggerEdge === 'FALLING' || s.triggerEdge === 'BOTH') && prev > thr && raw <= thr) return true;
  return false;
}

function advanceSim(elapsedSec) {
  const sps = DISP_PTS / (totalMs() / 1000);
  const n   = Math.max(1, Math.round(sps * elapsedSec));
  const dt  = elapsedSec / n;

  for (let k = 0; k < n; k++) {
    simT += dt;
    const tsUs = simT * 1e6;  // seconds → µs, same unit as ESP32 micros()
    for (let ch = 1; ch <= 4; ch++) {
      if (!state[ch].visible) continue;
      const raw = simSample(ch, simT);
      if (checkTrigger(ch, Math.round(raw))) trigFired = true;
      ring[ch][wHead[ch]]   = raw;
      ringTs[ch][wHead[ch]] = tsUs;
      wHead[ch] = (wHead[ch] + 1) % BUF_PTS;
    }
  }
}


/* ═══════════════════════════════════════════════════
   GRATICULE PLUGIN
   Draws scope-style grid (major + sub) directly on canvas.
═══════════════════════════════════════════════════ */
const graticulePlugin = {
  id: 'graticule',
  beforeDraw(instance) {
    const { ctx, chartArea } = instance;
    if (!chartArea) return;
    const { left, top, width, height } = chartArea;

    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();

    // Background
    ctx.fillStyle = '#060a0e';
    ctx.fillRect(left, top, width, height);

    // Sub-grid (5 sub-divs per major div)
    ctx.strokeStyle = '#0b1520'; ctx.lineWidth = 0.5;
    for (let i = 0; i <= H_DIV * 5; i++) {
      if (i % 5 === 0) continue;
      const x = left + i * width / (H_DIV * 5);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    for (let i = 0; i <= V_DIV * 5; i++) {
      if (i % 5 === 0) continue;
      const y = top + i * height / (V_DIV * 5);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
    }

    // Major grid
    ctx.strokeStyle = '#111e30'; ctx.lineWidth = 1;
    for (let i = 0; i <= H_DIV; i++) {
      const x = left + i * width / H_DIV;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    for (let i = 0; i <= V_DIV; i++) {
      const y = top + i * height / V_DIV;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
    }

    // Centre crosshairs (slightly brighter)
    ctx.strokeStyle = '#1c2e42'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(left + width / 2, top); ctx.lineTo(left + width / 2, top + height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(left, top + height / 2); ctx.lineTo(left + width, top + height / 2); ctx.stroke();

    ctx.restore();
  }
};

/* ═══════════════════════════════════════════════════
   Y AXIS  — one per channel
   Range always in raw ADC units.
   Half-range is Y_HALFRANGE / |a|: larger |a| → narrower raw window → taller curve.
   Smaller |a| → wider window → flatter curve.  Tick labels convert via a*v+b.
═══════════════════════════════════════════════════ */
function yAxisRange(ch) {
  const s    = state[ch];
  const ctr  = ADC_MIDSCALE + s.offset;
  const half = s.a !== 0 ? Y_HALFRANGE / Math.abs(s.a) : Y_HALFRANGE;
  return { min: ctr - half, max: ctr + half };
}

function buildYAxis(ch) {
  const r = yAxisRange(ch);
  // CH1, CH3 → left side   /   CH2, CH4 → right side
  const side = (ch === 1 || ch === 3) ? 'left' : 'right';
  return {
    type:     'linear',
    position: side,
    display:  state[ch].visible,
    min:      r.min,
    max:      r.max,
    grid:   { display: false },
    border: { color: state[ch].color + '50', width: 1 },
    ticks:  {
      color:         state[ch].color + 'aa',
      font:          { family: "'Share Tech Mono', monospace", size: 8 },
      maxTicksLimit: V_DIV + 1,
      callback(value) {
        const v   = convert(ch, value);
        const mag = Math.abs(v);
        return v.toFixed(mag >= 1000 ? 0 : mag >= 100 ? 1 : mag >= 1 ? 2 : 3)
               + (state[ch].units || '');
      }
    }
  };
}

/* ═══════════════════════════════════════════════════
   CHART INIT
═══════════════════════════════════════════════════ */
Chart.register(graticulePlugin);
if (window['chartjs-plugin-annotation']) {
  Chart.register(window['chartjs-plugin-annotation']);
}

const chartCtx = document.getElementById('scopeChart').getContext('2d');

const scalesConfig = {
  x: {
    type:   'linear',
    min:    0,
    max:    totalMs(),
    grid:   { display: false },
    border: { display: false },
    ticks: {
      color:    '#2a3e56',
      font:     { family: "'Share Tech Mono', monospace", size: 9 },
      stepSize: tbMs,
      callback: v => {
        if (v === 0) return '0';
        if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 's';
        return v + 'ms';
      }
    },
  }
};
CH_DEFS.forEach(d => { scalesConfig['y' + d.id] = buildYAxis(d.id); });

const chart = new Chart(chartCtx, {
  type: 'line',
  data: {
    datasets: CH_DEFS.map(d => ({
      label:       'CH' + d.id,
      data:        [],
      borderColor: d.color,
      borderWidth: 1.5,
      pointRadius: 0,
      tension:     0,
      parsing:     false,
      yAxisID:     'y' + d.id,
    }))
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend:     { display: false },
      annotation: { annotations: {} },
      tooltip: {
        callbacks: {
          label(context) {
            const ch  = context.datasetIndex + 1;
            const raw = context.parsed.y;
            const v   = convert(ch, raw);
            const mag = Math.abs(v);
            const str = v.toFixed(mag >= 1000 ? 0 : mag >= 100 ? 1 : mag >= 1 ? 2 : 3);
            return `CH${ch}: ${str}${state[ch].units || ''}`;
          }
        }
      },
    },
    scales: scalesConfig,
  }
});

/* ═══════════════════════════════════════════════════
   CHART DATA UPDATE
   Rebuilds all datasets from ring buffer every frame.
═══════════════════════════════════════════════════ */
function updateChart() {
  for (let ch = 1; ch <= 4; ch++) {
    chart.data.datasets[ch - 1].data = readRing(ch);
  }
  chart.update('none');
}

/* ═══════════════════════════════════════════════════
   UPDATE CHANNEL Y AXIS
   Call after offset or formula change.
═══════════════════════════════════════════════════ */
function updateChannelAxis(ch) {
  const axis = chart.options.scales['y' + ch];
  const r    = yAxisRange(ch);
  axis.min   = r.min;
  axis.max   = r.max;
  rebuildAnnotations();
  chart.update('none');
}

/* ═══════════════════════════════════════════════════
   ANNOTATIONS
   Zero line   : raw ADC_MIDSCALE — fixed physical position, moves on screen with offset
   Trig level  : raw ADC_MIDSCALE + triggerLevel
   Trig pos    : vertical dashed line at trigPosMs on X axis
═══════════════════════════════════════════════════ */
function hasTrigger() {
  return CH_DEFS.some(d => state[d.id].visible && state[d.id].triggerEdge !== 'NONE');
}

function rebuildAnnotations() {
  const anns = {};

  for (let i = 1; i <= 4; i++) {
    const s    = state[i];
    if (!s.visible) continue;

    const axId = 'y' + i;
    const zero = s.a !== 0 ? -s.b / s.a : 0;  // raw where a*raw+b = 0 → physical zero

    // Zero reference line
    anns['z' + i] = {
      type:        'line',
      yMin:        zero,
      yMax:        zero,
      yScaleID:    axId,
      borderColor: s.color + '50',
      borderWidth: 1.5,
      label: {
        display:         true,
        content:         `CH${i}`,
        position:        'start',
        backgroundColor: 'transparent',
        color:           s.color + '88',
        font:            { family: "'Share Tech Mono', monospace", size: 9 },
        padding:         { x: 3, y: 0 },
        yAdjust:         -8,
      }
    };

    // Trigger threshold (moves with offset so it stays relative to the signal)
    if (s.triggerEdge !== 'NONE') {
      const trigAbs = ADC_MIDSCALE + s.triggerLevel;
      anns['th' + i] = {
        type:        'line',
        yMin:        trigAbs,
        yMax:        trigAbs,
        yScaleID:    axId,
        borderColor: s.color + '65',
        borderWidth: 1,
        borderDash:  [5, 4],
        label: {
          display:         true,
          content:         'T' + i,
          position:        'end',
          backgroundColor: 'transparent',
          color:           s.color + '88',
          font:            { family: "'Share Tech Mono', monospace", size: 9 },
          padding:         { x: 3, y: 0 },
          yAdjust:         -8,
        }
      };
    }
  }

  // Trigger delay line: 0 delay → right edge, max delay → left edge
  if (hasTrigger()) {
    const lineX = totalMs() - trigPosMs;
    anns['tpos'] = {
      type:        'line',
      xMin:        lineX,
      xMax:        lineX,
      borderColor: '#ffb02099',
      borderWidth: 2,
      borderDash:  [6, 3],
      label: {
        display:         true,
        content:         '▼',
        position:        'start',
        backgroundColor: 'transparent',
        color:           '#ffffff40',
        font:            { size: 9 },
      }
    };
  }

  chart.options.plugins.annotation.annotations = anns;
  chart.update('none');
}

/* ═══════════════════════════════════════════════════
   CHANNEL PANEL BUILDER
═══════════════════════════════════════════════════ */
function buildPanel(id) {
  const cs  = state[id];
  const div = document.createElement('div');
  div.className            = 'ch-panel';
  div.id                   = 'ch' + id;
  div.style.background     = cs.color + '13';
  div.style.borderTopColor = cs.color;

  div.innerHTML = `
    <div class="ch-header">
      <span class="ch-name">CH ${id}</span>
      <input type="color" class="ch-color" value="${cs.color}"
             oninput="onColor(${id}, this.value)">
      <span class="mono" id="hex${id}">${cs.color}</span>
    </div>

    <div class="ch-field">
      <div class="ch-label">GPIO</div>
      <select class="ch-sel" onchange="callConfigChannel()">
        <option>GPI36</option><option>GPI39</option>
        <option>GPIO32</option><option>GPIO33</option>
        <option>GPI34</option><option>GPI35</option>
      </select>
    </div>

    <div class="ch-body">
      <div class="ch-left">
        <div class="formula-group">
          <div class="ch-label">Formula (ax + b)</div>
          <div class="formula-row">
            <input type="number" class="formula-input" step="any" placeholder="a" value="${cs.a}"
                   id="fa${id}" oninput="onFormula(${id})">
            <span class="formula-sep">x +</span>
            <input type="number" class="formula-input" step="any" placeholder="b" value="${cs.b}"
                   id="fb${id}" oninput="onFormula(${id})">
          </div>
          <div class="formula-row unit-row">
            <span class="formula-sep">unit:</span>
            <input type="text" class="formula-input unit-input" placeholder="V, A…"
                   value="${cs.units || ''}" id="fu${id}" oninput="onUnits(${id}, this.value)">
          </div>
        </div>

        <div class="sliders-row">
          <div class="vslider-col">
            <div class="ch-label">Offset</div>
            <input type="range" class="vslider" orient="vertical"
                   min="-1800" max="1800" step="16" value="${cs.offset}"
                   oninput="onOffset(${id}, +this.value)">
            <div class="val-display" id="ofv${id}">0</div>
          </div>
        </div>
      </div>

      <div class="trigger-section">
        <div class="ch-label">Trigger</div>
        <div class="trig-edge-row">
          <label class="trig-check">
            <input type="checkbox" id="trc${id}r" onchange="onTrigEdgeCheck(${id})">↑
          </label>
          <label class="trig-check">
            <input type="checkbox" id="trc${id}f" onchange="onTrigEdgeCheck(${id})">↓
          </label>
        </div>
        <div class="trigger-body">
          <input type="range" class="vslider" orient="vertical"
                 min="-2048" max="2048" step="16" value="${cs.triggerLevel}"
                 id="ts${id}" disabled
                 oninput="onTrigLevel(${id}, +this.value)">
          <div class="val-display" id="tv${id}">—</div>
        </div>
      </div>
    </div>
  `;
  return div;
}

function renderChannels(n) {
  const c = document.getElementById('channels');
  c.innerHTML = '';
  c.style.gridTemplateColumns = `repeat(${n}, 1fr)`;

  for (let i = 1; i <= 4; i++) {
    state[i].visible = i <= n;
    if (chart.options.scales['y' + i]) {
      chart.options.scales['y' + i].display = i <= n;
    }
  }
  for (let i = 1; i <= n; i++) c.appendChild(buildPanel(i));
  chart.data.datasets.forEach((ds, idx) => { ds.hidden = !state[idx + 1].visible; });
  rebuildAnnotations();
}

/* ═══════════════════════════════════════════════════
   SAMPLING RATE
═══════════════════════════════════════════════════ */
function setSamplingRate(delayUs) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(`SAMPLING;${delayUs}`);
}

/* ═══════════════════════════════════════════════════
   TOOLBAR HANDLERS
═══════════════════════════════════════════════════ */
function setChannelCount(n) {
  renderChannels(n);
  callConfigChannel();
}

function callConfigChannel() {
  fetch(`/api/cmd/config/${getVisibleChannelGPIOs()}`)
    .then(r  => r.text())
    .then(d  => console.log('ESP32 response:', d))
    .catch(e => console.warn('API error:', e));
}

function getVisibleChannelGPIOs() {
  let txt = '';
  for (let i = 1; i <= 4; i++) {
    const ch = document.getElementById(`ch${i}`);
    if (!ch) continue;
    const gpio = ch.querySelector('.ch-sel')?.value;
    if (gpio) txt += gpio + ';';
  }
  console.log('config:', txt);
  return txt.replaceAll(' ', '_');
}

// setTimebase: changes X axis range + tick density, flushes buffer
function setTimebase(ms) {
  tbMs = ms;
  chart.options.scales.x.max            = totalMs();
  chart.options.scales.x.ticks.stepSize = ms;

  clearBuffers();
  simT = 0;

  const sl = document.getElementById('trigPosSlider');
  if (sl) { sl.value = 100; }  // reset slider to right (0 delay)
  setTrigPos(0);
  rebuildAnnotations();
}

function setTrigPos(pct) {
  trigPosMs = totalMs() * pct / 100;
  updateTrigPosDisplay();
  rebuildAnnotations();
}

function updateTrigPosDisplay() {
  const el = document.getElementById('trigPosVal');
  if (!el) return;
  el.textContent = trigPosMs >= 1000
    ? (trigPosMs / 1000).toFixed(2) + 's'
    : Math.round(trigPosMs) + 'ms';
}

/* ═══════════════════════════════════════════════════
   CHANNEL HANDLERS
═══════════════════════════════════════════════════ */
function onColor(id, color) {
  state[id].color = color;
  document.getElementById('hex' + id).textContent = color;
  const p = document.getElementById('ch' + id);
  p.style.background     = color + '13';
  p.style.borderTopColor = color;
  chart.data.datasets[id - 1].borderColor        = color;
  chart.options.scales['y' + id].border.color    = color + '50';
  chart.options.scales['y' + id].ticks.color     = color + 'aa';
  rebuildAnnotations();
}


function onOffset(id, val) {
  state[id].offset = val;
  document.getElementById('ofv' + id).textContent = (val >= 0 ? '+' : '') + val;
  updateChannelAxis(id);  // Y axis range + annotations both depend on offset
}

function fmtTrig(id) {
  const disp = convert(id, ADC_MIDSCALE + state[id].triggerLevel);
  const mag  = Math.abs(disp);
  return disp.toFixed(mag >= 1000 ? 0 : mag >= 100 ? 1 : mag >= 1 ? 2 : 3)
         + (state[id].units || '');
}

function onTrigEdgeCheck(id) {
  const r = document.getElementById('trc' + id + 'r').checked;
  const f = document.getElementById('trc' + id + 'f').checked;
  state[id].triggerEdge = r && f ? 'BOTH' : r ? 'RISING' : f ? 'FALLING' : 'NONE';
  const on = state[id].triggerEdge !== 'NONE';
  document.getElementById('ts' + id).disabled = !on;
  document.getElementById('tv' + id).textContent = on ? fmtTrig(id) : '—';
  rebuildAnnotations();
  if (on) stopScope();   // freeze display as soon as trigger is armed
}

function onTrigLevel(id, val) {
  state[id].triggerLevel = val;
  document.getElementById('tv' + id).textContent = fmtTrig(id);
  rebuildAnnotations();
}

function onFormula(id) {
  const a = parseFloat(document.getElementById('fa' + id).value);
  const b = parseFloat(document.getElementById('fb' + id).value);
  state[id].a = isNaN(a) ? 1 : a;
  state[id].b = isNaN(b) ? 0 : b;
  updateChannelAxis(id);  // axis half-range depends on |a| → must recalculate
}

function onUnits(id, val) {
  state[id].units = val.trim();
  chart.update('none');
}

/* ═══════════════════════════════════════════════════
   START / STOP
═══════════════════════════════════════════════════ */
let rafId  = null;
let lastTs = null;

function startScope() {
  if (running) return;
  trigFired       = false;
  trigArmed       = false; // will be set after the delay elapses in frame()
  trigArmDeadline = performance.now() + trigPosMs;
  CH_DEFS.forEach(d => { prevRaw[d.id] = ADC_MIDSCALE; });
  running = true; lastTs = null;
  rafId = requestAnimationFrame(frame);
  const btn = document.getElementById('btnStart');
  btn.classList.add('active');
  if (hasTrigger()) btn.classList.add('armed');
}

function stopScope() {
  running   = false;
  trigArmed = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  lastTs = null;
  const btn = document.getElementById('btnStart');
  btn.classList.remove('active', 'armed');
}

function frame(ts) {
  if (!running) return;
  const elapsed = lastTs !== null ? (ts - lastTs) / 1000 : 0.016;
  lastTs = ts;

  // Arm trigger once the delay has elapsed
  if (!trigArmed && hasTrigger() && performance.now() >= trigArmDeadline) {
    trigArmed = true;
    CH_DEFS.forEach(d => { prevRaw[d.id] = ADC_MIDSCALE; }); // clean edge state at arm
  }

  if (simMode) advanceSim(Math.min(elapsed, 0.12));
  updateChart();
  if (trigFired) { trigFired = false; stopScope(); return; }
  rafId = requestAnimationFrame(frame);
}

/* ═══════════════════════════════════════════════════
   WEBSOCKET  — ADC frames from ESP32
   Format: "ADC;{tsUs};{raw0};{raw1};...\n"
   Several lines may arrive in one chunk (split on \n).
   On first real data: disable simulation mode.
═══════════════════════════════════════════════════ */
const socket = new WebSocket(`ws://${window.location.hostname}:81`);
socket.onopen  = () => {
  console.log('[ws] connected');
  callConfigChannel();   // push GPIO config to ESP32
  if (!running) startScope();
};
socket.onerror = e   => console.warn('[ws] error:', e);

socket.onmessage = function(event) {
  const lines = event.data.split('\n');
  for (const line of lines) {
    if (line.startsWith('ADC')) parseADCLine(line);
  }
};

function parseADCLine(line) {
  const p = line.split(';');
  // p[0]='ADC'  p[1]=timestampµs  p[2..]=raw values per active slot in order
  if (p.length < 3) return;

  simMode = false;    // real data is flowing → freeze simulation

  const tsUs = parseInt(p[1]);  // µs from ESP32 micros()
  for (let ch = 1; ch <= 4; ch++) {
    if (!state[ch].visible) continue;
    const raw = parseInt(p[ch + 1]);
    if (isNaN(raw)) continue;
    const clamped = Math.max(0, Math.min(4095, raw));
    if (checkTrigger(ch, clamped)) trigFired = true;
    ring[ch][wHead[ch]]   = clamped;
    ringTs[ch][wHead[ch]] = tsUs;
    wHead[ch] = (wHead[ch] + 1) % BUF_PTS;
  }
}

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
trigPosMs = 0;
renderChannels(1);
updateTrigPosDisplay();
startScope();  // demo: start immediately with simulation