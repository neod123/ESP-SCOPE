'use strict';

/* ═══════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════ */
const H_DIV    = 10;        // horizontal divisions
const V_DIV    = 8;         // vertical divisions
const V_RANGE  = 2048;      // Y axis half-range (ADC units, ±)
const DISP_PTS = 800;       // samples in the rolling window

const YSCALE_LABELS = ['100mV', '500mV', '1V', '2V'];
// Multiplier applied at read time: smaller scale = larger display amplitude
const YSCALE_MULT = [5.0, 2.0, 1.0, 0.5];

const CH_DEFS = [
  { id: 1, color: '#00e87a' },
  { id: 2, color: '#ff4060' },
  { id: 3, color: '#3ab8ff' },
  { id: 4, color: '#ffb020' },
];

// Each channel has its own simulated waveform parameters
const CH_WAVES = {
  1: { freq: 2.5,  amp: 700, ampVar: 180, varFreq: 0.12, phase: 0.0 },
  2: { freq: 6.0,  amp: 500, ampVar: 220, varFreq: 0.09, phase: 1.4 },
  3: { freq: 11.0, amp: 360, ampVar: 270, varFreq: 0.17, phase: 2.6 },
  4: { freq: 1.8,  amp: 620, ampVar: 130, varFreq: 0.07, phase: 0.8 },
};

/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
const state = {};
CH_DEFS.forEach(d => {
  state[d.id] = {
    color:        d.color,
    yScale:       3,      // index into YSCALE_LABELS (default: 2V/div)
    offset:       0,      // vertical offset in ADC units
    triggerEdge:  'NONE',
    triggerLevel: 0,
    visible:      true,
  };
});

let tbMs      = 100;    // ms per horizontal division
let trigPosMs = 100;    // trigger position in ms from left (10% default)
let running   = false;

const totalMs = () => tbMs * H_DIV;

/* ═══════════════════════════════════════════════════
   RING BUFFER
   Stores raw ADC-range values; offset & scale applied at read time
   so that moving sliders instantly updates the entire visible curve.
═══════════════════════════════════════════════════ */
const ring  = {};
const wHead = {};
CH_DEFS.forEach(d => { ring[d.id] = new Float32Array(DISP_PTS); wHead[d.id] = 0; });

function clearBuffers() {
  CH_DEFS.forEach(d => { ring[d.id].fill(0); wHead[d.id] = 0; });
}

function readRing(ch) {
  const mult = YSCALE_MULT[state[ch].yScale];
  const off  = state[ch].offset;
  const buf  = ring[ch];
  const h    = wHead[ch];
  const out  = new Array(DISP_PTS);
  for (let i = 0; i < DISP_PTS; i++) {
    out[i] = { x: xLUT[i], y: buf[(h + i) % DISP_PTS] * mult + off };
  }
  return out;
}



/* ═══════════════════════════════════════════════════
   SIMULATION
   Runs continuously; generates sinusoidal signals with
   slowly varying amplitudes to simulate real ADC noise.
  */
let simT = 0;

function simSample(ch, t) {
  const w   = CH_WAVES[ch];
  const amp = w.amp + w.ampVar * Math.sin(2 * Math.PI * w.varFreq * t + w.phase);
  return amp * Math.sin(2 * Math.PI * w.freq * t) + (Math.random() - 0.5) * 38;
}

function advanceSim(elapsedSec) {
  // Compute how many samples we need to push based on the current effective SPS
  const sps = DISP_PTS / (totalMs() / 1000);
  const n   = Math.max(1, Math.round(sps * elapsedSec));
  const dt  = elapsedSec / n;

  for (let k = 0; k < n; k++) {
    simT += dt;
    for (let ch = 1; ch <= 4; ch++) {
      if (!state[ch].visible) continue;
      ring[ch][wHead[ch]] = simSample(ch, simT);
      wHead[ch] = (wHead[ch] + 1) % DISP_PTS;
    }
  }
}

/* ═══════════════════════════════════════════════════
   X LOOKUP TABLE
   Pre-computed time values (ms) for each sample index.
   Rebuilt whenever timebase changes.
═══════════════════════════════════════════════════ */
let xLUT = [];

function rebuildXLUT() {
  const total = totalMs();
  const dt    = total / DISP_PTS;
  xLUT = Array.from({ length: DISP_PTS }, (_, i) => i * dt);
}

/* ═══════════════════════════════════════════════════
   GRATICULE PLUGIN
   Draws the oscilloscope-style grid (major + sub-divisions)
   directly on the canvas before Chart.js renders the datasets.
═══════════════════════════════════════════════════ */
const graticulePlugin = {
  id: 'graticule',
  beforeDraw(instance) {
    const { ctx, chartArea } = instance;
    if (!chartArea) return;
    const { left, top, width, height } = chartArea;

    ctx.save();
    // Clip to chart area so lines don't bleed into axes
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();

    // Background
    ctx.fillStyle = '#060a0e';
    ctx.fillRect(left, top, width, height);

    // Sub-grid (5 sub-divisions per major division)
    ctx.strokeStyle = '#0c1420';
    ctx.lineWidth   = 0.5;
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

    // Major grid lines
    ctx.strokeStyle = '#131e2e';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= H_DIV; i++) {
      const x = left + i * width / H_DIV;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    for (let i = 0; i <= V_DIV; i++) {
      const y = top + i * height / V_DIV;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
    }

    // Centre axis lines (slightly brighter than major grid)
    ctx.strokeStyle = '#1c2e42';
    ctx.lineWidth   = 1.5;
    const cx = left + width  / 2;
    const cy = top  + height / 2;
    ctx.beginPath(); ctx.moveTo(cx, top);  ctx.lineTo(cx, top + height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(left, cy); ctx.lineTo(left + width, cy); ctx.stroke();

    ctx.restore();
  }
};

/* ═══════════════════════════════════════════════════
   CHART INITIALISATION
═══════════════════════════════════════════════════ */
Chart.register(graticulePlugin);

const chartCtx = document.getElementById('scopeChart').getContext('2d');

// xLUT must exist before chart is created (used immediately in first update)
rebuildXLUT();

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
      parsing:     false,   // data is already {x, y} — skip Chart.js parsing
    }))
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend:     { display: false },
      annotation: { annotations: {} },
    },
    scales: {
      x: {
        type:   'linear',
        min:    0,
        max:    totalMs(),
        grid:   { display: false },
        border: { display: false },
        ticks: {
          color:    '#2a3e56',
          font:     { family: "'Share Tech Mono', monospace", size: 9 },
          stepSize: tbMs,                    // one label per division
          callback: v => {
            if (v === 0) return '';
            if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 's';
            return v + 'ms';
          }
        },
      },
      y: {
        min:    -V_RANGE,
        max:     V_RANGE,
        grid:   { display: false },
        border: { display: false },
        ticks: {
          color:    '#2a3e56',
          font:     { family: "'Share Tech Mono', monospace", size: 9 },
          stepSize: (V_RANGE * 2) / V_DIV,  // 512 → 8 equal divisions
          callback: v => v === 0 ? '0' : v,
        },
      }
    }
  }
});

/* ═══════════════════════════════════════════════════
   CHART DATA UPDATE
   Rebuilds ALL dataset points from the ring buffer on every frame,
   so that changing offset or scale updates the entire visible curve.
═══════════════════════════════════════════════════ */
function updateChart() {
  for (let ch = 1; ch <= 4; ch++) {
    chart.data.datasets[ch - 1].data = readRing(ch);
  }
  chart.update('none');
}

/* ═══════════════════════════════════════════════════
   ANNOTATIONS
   - Zero reference line per channel (shifts with offset slider)
   - Trigger level dashed line per channel (when edge ≠ NONE)
   - Trigger position vertical line (when any trigger is active)
═══════════════════════════════════════════════════ */
function hasTrigger() {
  return CH_DEFS.some(d => state[d.id].visible && state[d.id].triggerEdge !== 'NONE');
}

function rebuildAnnotations() {
  const anns = {};

  for (let i = 1; i <= 4; i++) {
    const s = state[i];
    if (!s.visible) continue;

    // Zero reference line — shows where 0V sits for this channel
    anns['z' + i] = {
      type:        'line',
      yMin:        s.offset,
      yMax:        s.offset,
      borderColor: s.color + '50',
      borderWidth: 1.5,
      label: {
        display:         true,
        content:         `CH${i} 0V`,
        position:        'start',
        backgroundColor: 'transparent',
        color:           s.color + '88',
        font:            { family: "'Share Tech Mono', monospace", size: 9 },
        padding:         { x: 3, y: 0 },
        yAdjust:         -8,
      }
    };

    // Trigger level line (horizontal dashed)
    if (s.triggerEdge !== 'NONE') {
      anns['th' + i] = {
        type:        'line',
        yMin:        s.triggerLevel,
        yMax:        s.triggerLevel,
        borderColor: s.color + '62',
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

  // Trigger position line (vertical dashed) — only when at least one trigger is armed
  if (hasTrigger()) {
    anns['tpos'] = {
      type:        'line',
      xMin:        trigPosMs,
      xMax:        trigPosMs,
      borderColor: '#ffffff2a',
      borderWidth: 1,
      borderDash:  [4, 4],
      label: {
        display:         true,
        content:         '▼',
        position:        'start',
        backgroundColor: 'transparent',
        color:           '#ffffff44',
        font:            { size: 9 },
        xAdjust:         0,
        yAdjust:         0,
      }
    };
  }

  chart.options.plugins.annotation.annotations = anns;
  // Force immediate repaint so annotation changes appear even when scope is stopped
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
      <select class="ch-sel">
        <option>GPI36</option><option>GPI36</option>
        <option>GPI39</option><option>GPI39</option>
        <option>GPIO32</option><option>GPIO32</option>
        <option>GPIO33</option><option>GPIO33</option>
        <option>GPI34</option><option>GPI34</option>
        <option>GPI35</option><option>GPI35</option>
      </select>
    </div>

    <div class="sliders-row">

      <!-- Y Scale: discrete 4 steps with tick labels -->
      <div class="vslider-col">
        <div class="ch-label">Y Scale</div>
        <div class="yscale-wrap">
          <div class="yscale-ticks">
            <span>2V</span><span>1V</span><span>500m</span><span>100m</span>
          </div>
          <input type="range" class="vslider" orient="vertical"
                 min="0" max="3" step="1" value="${cs.yScale}"
                 oninput="onYScale(${id}, +this.value)">
        </div>
        <div class="val-display" id="ysv${id}">${YSCALE_LABELS[cs.yScale]}/div</div>
      </div>

      <!-- Offset -->
      <div class="vslider-col">
        <div class="ch-label">Offset</div>
        <input type="range" class="vslider" orient="vertical"
               min="-1800" max="1800" step="16" value="${cs.offset}"
               oninput="onOffset(${id}, +this.value)">
        <div class="val-display" id="ofv${id}">0</div>
      </div>

    </div>

    <!-- Trigger: edge selector first, then level slider -->
    <div class="trigger-section">
      <div class="ch-label">Trigger</div>
      <select class="ch-sel" onchange="onTrigEdge(${id}, this.value)">
        <option>NONE</option><option>RISING</option><option>FALLING</option><option>BOTH</option>
      </select>
      <div class="trigger-body">
        <input type="range" class="vslider" orient="vertical"
               min="-1800" max="1800" step="16" value="${cs.triggerLevel}"
               id="ts${id}" disabled
               oninput="onTrigLevel(${id}, +this.value)">
        <div class="val-display" id="tv${id}">—</div>
      </div>
    </div>
  `;
  return div;
}

function renderChannels(n) {
  const c = document.getElementById('channels');
  c.innerHTML = '';
  c.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  for (let i = 1; i <= 4; i++) state[i].visible = i <= n;
  for (let i = 1; i <= n; i++) c.appendChild(buildPanel(i));
  chart.data.datasets.forEach((ds, idx) => { ds.hidden = !state[idx + 1].visible; });
  rebuildAnnotations();
}


function getVisibleChannelGPIOs()
{
    const result = [];
    let txt = "";
    for (let i = 1; i <= 4; i++)
    {
        const channel =
            document.getElementById(`ch${i}`);

        //
        // Skip hidden channels
        //

        if (!channel || channel.style.display === "none")
            continue;

        //
        // Get GPIO select value
        //

        const gpio =
            channel
                .querySelector(".ch-sel")
                ?.value;

         
        txt += gpio + ";";    
    }

    console.log("config: " + txt);

    return txt.replaceAll(" ", "_");;
}

/* ═══════════════════════════════════════════════════
   TOOLBAR HANDLERS
═══════════════════════════════════════════════════ */
function setChannelCount(n) {
    renderChannels(n);

    fetch(`/api/cmd/config/${getVisibleChannelGPIOs()}`)
        .then(response => response.text())
        .then(data =>        {  console.log("ESP32 response:", data);    })
        .catch(err =>        {  console.error("API error:", err);        });

}

function setTimebase(ms) {
  tbMs = ms;

  // Update X axis range and tick step (one label per division)
  chart.options.scales.x.max            = totalMs();
  chart.options.scales.x.ticks.stepSize = ms;

  // Rebuild xLUT to match new time range, flush old samples
  rebuildXLUT();
  clearBuffers();
  simT = 0;

  // Recalculate trigger position from current slider percentage
  const sl = document.getElementById('trigPosSlider');
  if (sl) {
    trigPosMs = totalMs() * (+sl.value) / 100;
    updateTrigPosDisplay();
  }

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
  chart.data.datasets[id - 1].borderColor = color;
  rebuildAnnotations();
}

function onYScale(id, val) {
  state[id].yScale = val;
  document.getElementById('ysv' + id).textContent = YSCALE_LABELS[val] + '/div';
  updateChart();  // re-reads ring buffer with new YSCALE_MULT → entire curve updates
}

function onOffset(id, val) {
  state[id].offset = val;
  document.getElementById('ofv' + id).textContent = (val >= 0 ? '+' : '') + val;
  updateChart();  // re-reads ring buffer with new offset → entire curve updates
  rebuildAnnotations();
}

function onTrigEdge(id, edge) {
  state[id].triggerEdge = edge;
  const sl = document.getElementById('ts' + id);
  const vl = document.getElementById('tv' + id);
  const on = edge !== 'NONE';
  sl.disabled    = !on;
  vl.textContent = on
    ? (state[id].triggerLevel >= 0 ? '+' : '') + state[id].triggerLevel
    : '—';
  rebuildAnnotations();
}

function onTrigLevel(id, val) {
  state[id].triggerLevel = val;
  document.getElementById('tv' + id).textContent = (val >= 0 ? '+' : '') + val;
  rebuildAnnotations();
}

/* ═══════════════════════════════════════════════════
   START / STOP
═══════════════════════════════════════════════════ */
let rafId  = null;
let lastTs = null;

function startScope() {
  if (running) return;
  running = true;
  lastTs  = null;
  rafId   = requestAnimationFrame(frame);
  document.getElementById('btnStart').classList.add('active');
}

function stopScope() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  lastTs = null;
  document.getElementById('btnStart').classList.remove('active');
}

function frame(ts) {
  if (!running) return;
  const elapsed = lastTs !== null ? (ts - lastTs) / 1000 : 0.016;
  lastTs = ts;
  advanceSim(Math.min(elapsed, 0.12));  // cap at 120ms to avoid huge jumps on tab restore
  updateChart();
  rafId = requestAnimationFrame(frame);
}

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
trigPosMs = totalMs() * 0.10;   // 10% = 1 division from left
renderChannels(4);
updateTrigPosDisplay();
startScope();




const socket   = new WebSocket('ws://192.168.4.1:81'); 
socket.onopen  = function(e) {  console.log("[open] Connexion opened");};
socket.onerror = function(error) {  console.log(`[error] ${error.message}`);};


socket.onmessage = function(event) 
{
  //payload example : "ADC;181346;0;0;0"
  console.log("Message received :", event.data);




  // Si tu veux manipuler les données (split)
  if (event.data.startsWith("ADC")) {
      const parts = event.data.split(';');
      console.log("Valeur ADC :", parts[1]); // Affiche 181346
  }
};
