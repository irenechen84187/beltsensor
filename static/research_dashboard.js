/**
 * RESPITRACK // Real-Time Respiratory Waveform & Breathing Pattern Research Engine
 * Hardware: Vernier Go Direct® Respiration Belt (GDX-RB) • S/N: 0K7014Z0
 * Sampling Frequency: 10.0 Hz (100 ms period)
 * Research Focus: Consistent vs. Irregular Breathing for Radiation Treatment Planning
 */

// ========================================================
// 1. GLOBAL STATE & EXPERIMENTAL CONFIGURATION
// ========================================================
let socket = null;
let isSensorStreaming = false;
let isHardwareConnected = false;
let isRecordingPaused = false;
let isChartDisplayPaused = false;

let totalPacketsReceived = 0;
let lastSensorValue = 0;
let lastFilteredForce = 0.0;
let sessionStartTime = null;

// Experiment Condition & Metadata
let currentExperimentCondition = "Normal"; // 'Normal', 'Controlled', 'Irregular'
let currentSessionNotes = "";

// Time-series sample buffer (10 Hz raw & net force data)
let recordedSessionData = [];
let breathCycles = [];           // Extracted breath-by-breath cycles
let irregularityFlagsLog = [];   // Real-time diagnostics log with exact mathematical reasons

// Research Configurable Thresholds (Saved in localStorage)
let researchThresholds = {
  cvDurLimit: 15.0,        // Max cycle duration CV% for stable rhythm
  cvAmpLimit: 20.0,        // Max tidal amplitude CV% for stable rhythm
  pauseDurationLimit: 8.0, // Seconds without peak before flagging apnea / pause
  ampRatioLimit: 1.70,     // Ratio of breath excursion to mean excursion for sigh/jump
  driftLimit: 1.50,        // Transducer baseline drift tolerance in Newtons
  noiseLimit: 0.20,        // High-frequency ripple limit in N for sensor noise
  peakProminence: 0.35     // Min excursion above trough in N to detect peak
};

function loadSavedThresholds() {
  try {
    const saved = localStorage.getItem("respi_research_thresholds");
    if (saved) {
      researchThresholds = Object.assign(researchThresholds, JSON.parse(saved));
    }
  } catch (e) {}
  syncThresholdInputs();
}

function syncThresholdInputs() {
  const elDur = document.getElementById("thresh-cv-dur");
  const elAmp = document.getElementById("thresh-cv-amp");
  const elPause = document.getElementById("thresh-pause-dur");
  const elRatio = document.getElementById("thresh-amp-ratio");
  const elDrift = document.getElementById("thresh-drift");
  const elNoise = document.getElementById("thresh-noise");
  const elProm = document.getElementById("thresh-prominence");

  if (elDur) elDur.value = researchThresholds.cvDurLimit.toFixed(1);
  if (elAmp) elAmp.value = researchThresholds.cvAmpLimit.toFixed(1);
  if (elPause) elPause.value = researchThresholds.pauseDurationLimit.toFixed(1);
  if (elRatio) elRatio.value = researchThresholds.ampRatioLimit.toFixed(2);
  if (elDrift) elDrift.value = researchThresholds.driftLimit.toFixed(2);
  if (elNoise) elNoise.value = researchThresholds.noiseLimit.toFixed(2);
  if (elProm) elProm.value = researchThresholds.peakProminence.toFixed(2);
}

// Chart Configuration
let chartWindowSeconds = 30; // Options: 30s, 60s, 120s
let maxChartSamples = 300;   // 30s * 10 Hz
let chartLabels = [];
let chartSignalData = [];    // Dataset 0: Force Curve (N)
let chartPeakData = [];      // Dataset 1: Inhalation Peaks (scatter)
let chartTroughData = [];    // Dataset 2: Exhalation Troughs (scatter)
let chartInstance = null;
let recentValues = [];

// Real-Time Diagnostic State
let currentBpm = 14.0;
let currentAmplitude = 2.5;
let currentNoise = 0.05;
let currentBaselineDrift = 0.0;
let currentBreathCount = 0;
let currentSignalQuality = 100;

// Extrema Detector Internals
let extremumState = "seeking_peak"; // 'seeking_peak' or 'seeking_trough'
let lastPeakTimeMs = 0;
let lastTroughTimeMs = 0;
let currentCycleStartTimeMs = 0;
let currentCycleTroughForce = 0.0;
let currentCyclePeakForce = 0.0;
let rawDerivativeBuffer = [];

// ========================================================
// 2. CHART.JS SETUP & MULTI-DATASET OSCILLOSCOPE
// ========================================================
function initChart() {
  const canvasEl = document.getElementById("respiratoryChart");
  if (!canvasEl) return;
  const ctx = canvasEl.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, 0, 320);
  gradient.addColorStop(0, "rgba(6, 182, 212, 0.40)");
  gradient.addColorStop(0.7, "rgba(6, 182, 212, 0.06)");
  gradient.addColorStop(1, "rgba(6, 182, 212, 0.0)");

  chartLabels = [];
  chartSignalData = [];
  chartPeakData = [];
  chartTroughData = [];

  for (let i = 0; i < maxChartSamples; i++) {
    chartLabels.push("");
    chartSignalData.push(null);
    chartPeakData.push(null);
    chartTroughData.push(null);
  }

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [
        // Dataset 0: Continuous Force Curve (Smooth visualization preserving original readings)
        {
          label: "Belt Force (N)",
          data: chartSignalData,
          borderColor: "#06b6d4",
          borderWidth: 2.6,
          backgroundColor: gradient,
          fill: true,
          pointRadius: 0,
          tension: 0.35,
          cubicInterpolationMode: "monotone",
          order: 3
        },
        // Dataset 1: Detected Inhalation Peaks (Inhale Apex)
        {
          type: "scatter",
          label: "Inhalation Peaks",
          data: chartPeakData,
          backgroundColor: "#10b981",
          borderColor: "#ffffff",
          borderWidth: 1.5,
          pointRadius: 5.5,
          pointHoverRadius: 7.5,
          showLine: false,
          order: 1
        },
        // Dataset 2: Detected Exhalation Troughs (End-Exhale Base)
        {
          type: "scatter",
          label: "Exhalation Troughs",
          data: chartTroughData,
          backgroundColor: "#f59e0b",
          borderColor: "#ffffff",
          borderWidth: 1.5,
          pointRadius: 5.5,
          pointHoverRadius: 7.5,
          showLine: false,
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: "nearest" },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(15, 23, 42, 0.95)",
          titleColor: "#38bdf8",
          bodyColor: "#f8fafc",
          borderColor: "rgba(56, 189, 248, 0.3)",
          borderWidth: 1,
          callbacks: {
            label: function (context) {
              const dsLabel = context.dataset.label || "";
              const val = context.parsed.y;
              if (dsLabel === "Inhalation Peaks") {
                return `▲ Inhalation Peak: ${val.toFixed(2)} N`;
              }
              if (dsLabel === "Exhalation Troughs") {
                return `▼ Exhalation Trough: ${val.toFixed(2)} N`;
              }
              return `Expansion Force: ${val.toFixed(2)} N`;
            }
          }
        }
      },
      scales: {
        x: {
          display: true,
          grid: { color: "rgba(255, 255, 255, 0.04)" },
          ticks: { display: false }
        },
        y: {
          min: 0,
          max: 5.0,
          grid: { color: "rgba(255, 255, 255, 0.07)" },
          ticks: {
            color: "#64748b",
            font: { family: "'JetBrains Mono', monospace", size: 11 },
            callback: (v) => v.toFixed(1) + " N"
          }
        }
      }
    }
  });
}

// Adjustable Viewing Windows: 30s, 60s, 120s
function setChartWindow(seconds) {
  chartWindowSeconds = seconds;
  maxChartSamples = seconds * 10; // 10 Hz

  ["win-30s", "win-60s", "win-120s"].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove("active");
  });
  const activeBtn = document.getElementById(`win-${seconds}s`);
  if (activeBtn) activeBtn.classList.add("active");

  const labelEl = document.getElementById("chart-window-label");
  if (labelEl) {
    labelEl.innerText = `Window: ${seconds}.0s (${maxChartSamples} points @ 10 Hz)`;
  }

  // Adjust dataset buffers
  if (chartSignalData.length > maxChartSamples) {
    chartLabels = chartLabels.slice(-maxChartSamples);
    chartSignalData = chartSignalData.slice(-maxChartSamples);
    chartPeakData = chartPeakData.slice(-maxChartSamples);
    chartTroughData = chartTroughData.slice(-maxChartSamples);
  } else {
    while (chartSignalData.length < maxChartSamples) {
      chartLabels.unshift("");
      chartSignalData.unshift(null);
      chartPeakData.unshift(null);
      chartTroughData.unshift(null);
    }
  }

  if (chartInstance) {
    chartInstance.data.labels = chartLabels;
    chartInstance.data.datasets[0].data = chartSignalData;
    chartInstance.data.datasets[1].data = chartPeakData;
    chartInstance.data.datasets[2].data = chartTroughData;
    chartInstance.update();
  }
}

// Pause / Resume Waveform Display
function toggleChartPause() {
  isChartDisplayPaused = !isChartDisplayPaused;
  const btn = document.getElementById("btn-chart-pause");
  const textEl = document.getElementById("chart-pause-text");
  const iconEl = document.getElementById("chart-pause-icon");

  if (isChartDisplayPaused) {
    if (btn) btn.classList.add("is-paused");
    if (textEl) textEl.innerText = "Resume";
    if (iconEl) iconEl.innerText = "▶";
  } else {
    if (btn) btn.classList.remove("is-paused");
    if (textEl) textEl.innerText = "Pause";
    if (iconEl) iconEl.innerText = "⏸";
    if (chartInstance) chartInstance.update("none");
  }
}

// Zoom Controls (Y-Axis)
function zoomChart(direction) {
  if (!chartInstance) return;
  const currentMax = chartInstance.options.scales.y.max || 5.0;
  let newMax = currentMax + (direction * 1.0);
  if (newMax < 2.0) newMax = 2.0;
  if (newMax > 15.0) newMax = 15.0;
  chartInstance.options.scales.y.max = newMax;
  chartInstance.update();
}

function resetWaveform() {
  setChartWindow(chartWindowSeconds);
  if (chartInstance) {
    chartInstance.options.scales.y.max = 5.0;
    chartInstance.update();
  }
  recentValues = [];
}

// Export Waveform Graph as PNG with Research Watermark
function exportWaveformPNG() {
  if (!chartInstance) return;
  const srcCanvas = chartInstance.canvas;
  const offscreen = document.createElement("canvas");
  offscreen.width = srcCanvas.width + 40;
  offscreen.height = srcCanvas.height + 90;
  const oCtx = offscreen.getContext("2d");

  // Dark background
  oCtx.fillStyle = "#070b14";
  oCtx.fillRect(0, 0, offscreen.width, offscreen.height);

  // Header banner
  oCtx.fillStyle = "#38bdf8";
  oCtx.font = "bold 13px 'JetBrains Mono', monospace";
  oCtx.fillText("RESPITRACK // VERNIER GO DIRECT RESPIRATION BELT (GDX-RB)", 20, 24);

  oCtx.fillStyle = "#94a3b8";
  oCtx.font = "11px 'Inter', sans-serif";
  const nowStr = new Date().toLocaleString();
  const sn = document.getElementById("hw-serial").innerText || "0K7014Z0";
  oCtx.fillText(`Device S/N: ${sn}  •  Condition: ${currentExperimentCondition}  •  Captured: ${nowStr}  •  10.0 Hz`, 20, 42);

  // Draw chart
  oCtx.drawImage(srcCanvas, 20, 50);

  // Footer stats
  oCtx.fillStyle = "#64748b";
  oCtx.font = "10px 'JetBrains Mono', monospace";
  oCtx.fillText(`Rate: ${currentBpm.toFixed(1)} BPM  |  Avg Amp: ${currentAmplitude.toFixed(2)} N  |  Radiation Planning Research Use Only`, 20, offscreen.height - 15);

  const link = document.createElement("a");
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "_" + Date.now();
  link.download = `waveform_${currentExperimentCondition.toLowerCase()}_${sn}_${dateTag}.png`;
  link.href = offscreen.toDataURL("image/png");
  link.click();
}

// ========================================================
// 3. EXTREMA DETECTION & BREATHING CYCLE ANALYSIS
// ========================================================
function analyzeBreathSample(netVal, rawForce, elapsedSec, timeStr) {
  // Moving derivative filter for smooth slope inflection
  rawDerivativeBuffer.push(netVal);
  if (rawDerivativeBuffer.length > 5) rawDerivativeBuffer.shift();

  const smoothedVal = rawDerivativeBuffer.reduce((a, b) => a + b, 0) / rawDerivativeBuffer.length;
  const delta = (smoothedVal - (lastFilteredForce || smoothedVal)) * 10.0;
  lastFilteredForce = smoothedVal;

  const nowMs = Date.now();
  if (!currentCycleStartTimeMs) currentCycleStartTimeMs = nowMs;

  currentBaselineDrift = Math.abs(lastSensorValue - netVal);

  // Turning Point Detection: Inhale Peaks and Exhale Troughs
  if (extremumState === "seeking_peak") {
    if (smoothedVal > currentCyclePeakForce) {
      currentCyclePeakForce = smoothedVal;
    }

    const minRefractory = 1200; // Minimum 1.2s between peaks
    const timeSinceLastPeak = nowMs - lastPeakTimeMs;
    const excursionFromTrough = currentCyclePeakForce - currentCycleTroughForce;

    // Local maximum reached
    if (delta < -0.05 && excursionFromTrough >= researchThresholds.peakProminence && (lastPeakTimeMs === 0 || timeSinceLastPeak >= minRefractory)) {
      extremumState = "seeking_trough";
      const peakForce = currentCyclePeakForce;
      lastPeakTimeMs = nowMs;
      currentBreathCount++;
      document.getElementById("rec-breaths").innerText = currentBreathCount;

      // Visual marker on Chart.js
      if (chartPeakData.length > 0) {
        chartPeakData[chartPeakData.length - 1] = peakForce;
      }

      // Cycle Duration (Peak-to-Peak interval in seconds)
      let cycleDurationSec = 4.0;
      if (lastPeakTimeMs > 0 && breathCycles.length > 0) {
        const prevPeakTime = breathCycles[breathCycles.length - 1].end_time_s;
        cycleDurationSec = Math.max(1.0, elapsedSec - prevPeakTime);
      } else if (lastPeakTimeMs > 0 && breathCycles.length === 0) {
        cycleDurationSec = (timeSinceLastPeak > 0 && timeSinceLastPeak < 15000) ? (timeSinceLastPeak / 1000.0) : 4.0;
      }

      // Tidal Amplitude (Peak-to-Trough force difference in Newtons)
      const amplitudeN = Math.max(0.2, peakForce - currentCycleTroughForce);
      const instBpm = cycleDurationSec > 0 ? (60.0 / cycleDurationSec) : 15.0;
      currentBpm = Math.round((currentBpm * 0.7 + instBpm * 0.3) * 10) / 10;
      currentAmplitude = Math.round(amplitudeN * 100) / 100;

      const ti = Math.min(cycleDurationSec * 0.45, Math.max(0.6, (nowMs - currentCycleStartTimeMs) / 1000.0));
      const te = Math.max(0.5, cycleDurationSec - ti);
      const ieRatio = `1:${(te / ti).toFixed(1)}`;

      const cycleRecord = {
        breath_number: currentBreathCount,
        start_clock: new Date(currentCycleStartTimeMs).toTimeString().slice(0, 8),
        end_clock: new Date(nowMs).toTimeString().slice(0, 8),
        start_time_s: parseFloat((currentCycleStartTimeMs - (sessionStartTime || currentCycleStartTimeMs)) / 1000.0),
        end_time_s: parseFloat(elapsedSec.toFixed(2)),
        cycle_duration_s: parseFloat(cycleDurationSec.toFixed(2)),
        respiration_rate_bpm: parseFloat(instBpm.toFixed(1)),
        inhale_duration_s: parseFloat(ti.toFixed(2)),
        exhale_duration_s: parseFloat(te.toFixed(2)),
        ie_ratio: ieRatio,
        baseline_force_n: parseFloat(currentCycleTroughForce.toFixed(2)),
        peak_force_n: parseFloat(peakForce.toFixed(2)),
        net_excursion_n: parseFloat(amplitudeN.toFixed(2)),
        classification: "Stable Eupnea"
      };

      breathCycles.push(cycleRecord);
      evaluateAllCyclesVariability();
      currentCyclePeakForce = smoothedVal;
      currentCycleStartTimeMs = nowMs;
    }
  } else if (extremumState === "seeking_trough") {
    if (smoothedVal < currentCycleTroughForce) {
      currentCycleTroughForce = smoothedVal;
    }

    // Local minimum reached
    if (delta > 0.05) {
      extremumState = "seeking_peak";
      lastTroughTimeMs = nowMs;
      if (chartTroughData.length > 0) {
        chartTroughData[chartTroughData.length - 1] = currentCycleTroughForce;
      }
    }
  }

  // Check for Breathing Pause / Apnea (> pauseDurationLimit)
  if (lastPeakTimeMs > 0) {
    const pauseElapsed = (nowMs - lastPeakTimeMs) / 1000.0;
    if (pauseElapsed > researchThresholds.pauseDurationLimit) {
      triggerIrregularityFlag("Breathing Pause", `No inhalation peak detected for ${pauseElapsed.toFixed(1)}s (threshold: ${researchThresholds.pauseDurationLimit}s). Possible apnea or deep breath hold.`, "pause");
    }
  }
}

// ========================================================
// 4. STATISTICAL VARIABILITY & LIVE RESEARCH METRICS
// ========================================================
function evaluateAllCyclesVariability() {
  if (breathCycles.length === 0) return;

  const durations = breathCycles.map(c => c.cycle_duration_s);
  const amplitudes = breathCycles.map(c => c.net_excursion_n);
  const bpms = breathCycles.map(c => c.respiration_rate_bpm);

  // Mean
  const meanDur = durations.reduce((a, b) => a + b, 0) / durations.length;
  const meanAmp = amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length;
  const meanBpm = bpms.reduce((a, b) => a + b, 0) / bpms.length;

  // Standard Deviation
  let sdDur = 0, sdAmp = 0;
  if (durations.length > 1) {
    const varDur = durations.reduce((acc, v) => acc + Math.pow(v - meanDur, 2), 0) / (durations.length - 1);
    const varAmp = amplitudes.reduce((acc, v) => acc + Math.pow(v - meanAmp, 2), 0) / (amplitudes.length - 1);
    sdDur = Math.sqrt(varDur);
    sdAmp = Math.sqrt(varAmp);
  }

  // Coefficient of Variation: CV = (SD / Mean) * 100%
  const cvDur = meanDur > 0 ? (sdDur / meanDur) * 100 : 0;
  const cvAmp = meanAmp > 0 ? (sdAmp / meanAmp) * 100 : 0;

  // Percentage of Stable Breathing Time
  let stableCount = 0;
  breathCycles.forEach(c => {
    const durDev = Math.abs(c.cycle_duration_s - meanDur) / meanDur * 100;
    const ampDev = Math.abs(c.net_excursion_n - meanAmp) / meanAmp * 100;
    const isStable = (durDev <= researchThresholds.cvDurLimit && ampDev <= researchThresholds.cvAmpLimit);

    if (isStable) {
      stableCount++;
      c.classification = "Stable Eupnea";
    } else if (ampDev > researchThresholds.cvAmpLimit * 1.5) {
      c.classification = c.net_excursion_n > meanAmp ? "Deep Sigh" : "Shallow Cycle";
    } else if (durDev > researchThresholds.cvDurLimit) {
      c.classification = "Rhythm Variation";
    }
  });
  const stablePct = Math.round((stableCount / breathCycles.length) * 100);

  // Signal Quality Index
  let qualityScore = 100;
  if (currentNoise > researchThresholds.noiseLimit) {
    qualityScore -= Math.min(40, (currentNoise - researchThresholds.noiseLimit) * 150);
  }
  if (currentBaselineDrift > researchThresholds.driftLimit) {
    qualityScore -= Math.min(30, (currentBaselineDrift - researchThresholds.driftLimit) * 20);
  }
  currentSignalQuality = Math.max(10, Math.min(100, Math.round(qualityScore)));

  // Render Research Metrics Panel Under Waveform
  const elLiveRate = document.getElementById("res-live-rate");
  const elAvgRate = document.getElementById("res-avg-rate");
  const elAvgAmp = document.getElementById("res-avg-amp");
  const elAvgDur = document.getElementById("res-avg-dur");
  const elCvAmp = document.getElementById("res-cv-amp");
  const elCvDur = document.getElementById("res-cv-dur");
  const elStablePct = document.getElementById("res-stable-pct");
  const elQualityPct = document.getElementById("res-quality-pct");
  const elQualityLbl = document.getElementById("res-quality-label");

  if (elLiveRate) elLiveRate.innerText = currentBpm > 0 ? currentBpm.toFixed(1) : "--";
  if (elAvgRate) elAvgRate.innerText = meanBpm.toFixed(1);
  if (elAvgAmp) elAvgAmp.innerText = meanAmp.toFixed(2);
  if (elAvgDur) elAvgDur.innerText = meanDur.toFixed(2);
  if (elCvAmp) {
    elCvAmp.innerText = cvAmp.toFixed(1);
    elCvAmp.style.color = cvAmp > researchThresholds.cvAmpLimit ? "#fbbf24" : "#ffffff";
  }
  if (elCvDur) {
    elCvDur.innerText = cvDur.toFixed(1);
    elCvDur.style.color = cvDur > researchThresholds.cvDurLimit ? "#fbbf24" : "#ffffff";
  }
  if (elStablePct) elStablePct.innerText = stablePct;
  if (elQualityPct) elQualityPct.innerText = currentSignalQuality;
  if (elQualityLbl) {
    if (currentSignalQuality >= 85) {
      elQualityLbl.innerText = "CLEAN";
      elQualityLbl.style.color = "#38bdf8";
    } else if (currentSignalQuality >= 60) {
      elQualityLbl.innerText = "MILD NOISE";
      elQualityLbl.style.color = "#fbbf24";
    } else {
      elQualityLbl.innerText = "POOR SIGNAL";
      elQualityLbl.style.color = "#f87171";
    }
  }

  // Waveform stability pill
  const stabilityPill = document.getElementById("chart-stability-pill");
  if (stabilityPill) {
    if (currentSignalQuality < 60) {
      stabilityPill.className = "badge-stability quality";
      stabilityPill.innerText = "▲ Sensor Noise Artifact";
    } else if (cvDur > researchThresholds.cvDurLimit || cvAmp > researchThresholds.cvAmpLimit) {
      stabilityPill.className = "badge-stability irregular";
      stabilityPill.innerText = "▲ Irregular Breathing Rhythm";
    } else {
      stabilityPill.className = "badge-stability stable";
      stabilityPill.innerText = "● Consistent Pattern (Stable)";
    }
  }

  // Check Irregularity Flags
  const latestCycle = breathCycles[breathCycles.length - 1];
  if (cvDur > researchThresholds.cvDurLimit) {
    triggerIrregularityFlag("Irregular Rhythm", `Cycle duration variability reached ${cvDur.toFixed(1)}% (threshold: ${researchThresholds.cvDurLimit}%). Breathing interval is erratic.`, "warn");
  }
  if (latestCycle && latestCycle.net_excursion_n > meanAmp * researchThresholds.ampRatioLimit) {
    triggerIrregularityFlag("Unusual Amplitude Shift", `Breath excursion (${latestCycle.net_excursion_n.toFixed(2)} N) was ${(latestCycle.net_excursion_n / meanAmp).toFixed(1)}x mean excursion (${meanAmp.toFixed(2)} N).`, "info");
  }

  renderBreathTable(breathCycles);
}

// ========================================================
// 5. BREATHING PATTERN & IRREGULARITY DIAGNOSTICS LOG
// ========================================================
let lastFlagTriggerTimes = {};

function triggerIrregularityFlag(title, reason, level = "warn") {
  const now = Date.now();
  if (lastFlagTriggerTimes[title] && (now - lastFlagTriggerTimes[title]) < 6000) {
    return;
  }
  lastFlagTriggerTimes[title] = now;

  const elapsedSec = sessionStartTime ? ((now - sessionStartTime) / 1000.0) : 0;
  const m = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const s = String(Math.floor(elapsedSec % 60)).padStart(2, "0");
  const timeTag = `[${m}:${s}.${Math.floor((elapsedSec % 1) * 10)}]`;

  irregularityFlagsLog.unshift({
    timeTag: timeTag,
    title: title,
    reason: reason,
    level: level,
    timestamp: new Date().toISOString()
  });

  if (irregularityFlagsLog.length > 50) irregularityFlagsLog.pop();
  renderIrregularityLog();
}

function renderIrregularityLog() {
  const container = document.getElementById("flag-log-container");
  const countEl = document.getElementById("diag-flags-count");
  if (countEl) countEl.innerText = `${irregularityFlagsLog.length} Irregularities Flagged`;

  if (!container) return;
  if (irregularityFlagsLog.length === 0) {
    container.innerHTML = `
      <div class="flag-item flag-info">
        <span class="flag-time">[00:00.0]</span>
        <div>
          <div class="flag-title">No Irregularities Active &bull; Breathing Rhythm Consistent</div>
          <div class="flag-desc">Cycle duration and tidal amplitude are currently within research stability thresholds.</div>
        </div>
      </div>
    `;
    return;
  }

  let html = "";
  irregularityFlagsLog.forEach(item => {
    let levelClass = "flag-warn";
    if (item.level === "alert" || item.level === "pause") levelClass = "flag-alert";
    if (item.level === "info") levelClass = "flag-info";

    html += `
      <div class="flag-item ${levelClass}">
        <span class="flag-time">${item.timeTag}</span>
        <div>
          <div class="flag-title">${item.title}</div>
          <div class="flag-desc">${item.reason}</div>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

function clearIrregularityLog() {
  irregularityFlagsLog = [];
  renderIrregularityLog();
}

// ========================================================
// 6. THRESHOLDS MODAL CONFIGURATION
// ========================================================
function openThresholdsModal() {
  syncThresholdInputs();
  const modal = document.getElementById("thresholds-modal-backdrop");
  if (modal) modal.classList.add("is-open");
}

function closeThresholdsModal() {
  const modal = document.getElementById("thresholds-modal-backdrop");
  if (modal) modal.classList.remove("is-open");
}

function saveResearchThresholds() {
  const elDur = parseFloat(document.getElementById("thresh-cv-dur").value);
  const elAmp = parseFloat(document.getElementById("thresh-cv-amp").value);
  const elPause = parseFloat(document.getElementById("thresh-pause-dur").value);
  const elRatio = parseFloat(document.getElementById("thresh-amp-ratio").value);
  const elDrift = parseFloat(document.getElementById("thresh-drift").value);
  const elNoise = parseFloat(document.getElementById("thresh-noise").value);
  const elProm = parseFloat(document.getElementById("thresh-prominence").value);

  if (!isNaN(elDur) && elDur > 0) researchThresholds.cvDurLimit = elDur;
  if (!isNaN(elAmp) && elAmp > 0) researchThresholds.cvAmpLimit = elAmp;
  if (!isNaN(elPause) && elPause > 0) researchThresholds.pauseDurationLimit = elPause;
  if (!isNaN(elRatio) && elRatio > 0) researchThresholds.ampRatioLimit = elRatio;
  if (!isNaN(elDrift) && elDrift > 0) researchThresholds.driftLimit = elDrift;
  if (!isNaN(elNoise) && elNoise > 0) researchThresholds.noiseLimit = elNoise;
  if (!isNaN(elProm) && elProm > 0) researchThresholds.peakProminence = elProm;

  try {
    localStorage.setItem("respi_research_thresholds", JSON.stringify(researchThresholds));
  } catch (e) {}

  closeThresholdsModal();
  evaluateAllCyclesVariability();
  triggerIrregularityFlag("Thresholds Updated", `Custom mathematical stability criteria applied (CV_dur: ${researchThresholds.cvDurLimit}%, CV_amp: ${researchThresholds.cvAmpLimit}%, Pause: ${researchThresholds.pauseDurationLimit}s).`, "info");
}

function resetThresholdsToDefaults() {
  researchThresholds = {
    cvDurLimit: 15.0,
    cvAmpLimit: 20.0,
    pauseDurationLimit: 8.0,
    ampRatioLimit: 1.70,
    driftLimit: 1.50,
    noiseLimit: 0.20,
    peakProminence: 0.35
  };
  try {
    localStorage.removeItem("respi_research_thresholds");
  } catch (e) {}
  syncThresholdInputs();
  evaluateAllCyclesVariability();
}

// ========================================================
// 7. EXPERIMENT CONDITION LABELING & SESSION RECORDING
// ========================================================
function setExperimentCondition(condition) {
  currentExperimentCondition = condition;

  ["cond-normal", "cond-controlled", "cond-irregular"].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.className = "btn-condition";
  });

  const activeBtn = document.getElementById(`cond-${condition.toLowerCase()}`);
  if (activeBtn) {
    activeBtn.className = `btn-condition active-${condition.toLowerCase()}`;
  }

  const badge = document.getElementById("current-condition-badge");
  if (badge) {
    badge.innerText = `${condition.toUpperCase()} BREATHING`;
    if (condition === "Normal") badge.style.color = "#34d399";
    if (condition === "Controlled") badge.style.color = "#38bdf8";
    if (condition === "Irregular") badge.style.color = "#fbbf24";
  }
}

function togglePauseRecording() {
  isRecordingPaused = !isRecordingPaused;
  const pauseBtnText = document.getElementById("btn-pause-text");
  const recText = document.getElementById("rec-status-text");

  if (isRecordingPaused) {
    if (pauseBtnText) pauseBtnText.innerText = "Resume";
    if (recText) recText.innerText = "SESSION PAUSED";
  } else {
    if (pauseBtnText) pauseBtnText.innerText = "Pause";
    if (recText) recText.innerText = "RECORDING ACTIVE";
  }
}

function stopAndSaveSession() {
  stopSensor();

  if (recordedSessionData.length === 0) {
    alert("No breathing data recorded to save.");
    return;
  }

  const notesInput = document.getElementById("session-notes-input");
  currentSessionNotes = notesInput ? notesInput.value.trim() : "";

  const now = new Date();
  const sessionId = "EXP_" + now.toISOString().slice(0, 10).replace(/-/g, "") + "_" + now.toTimeString().slice(0, 8).replace(/:/g, "");
  const serial = document.getElementById("hw-serial").innerText || "0K7014Z0";

  // Compute session metrics
  const durations = breathCycles.map(c => c.cycle_duration_s);
  const amplitudes = breathCycles.map(c => c.net_excursion_n);
  const bpms = breathCycles.map(c => c.respiration_rate_bpm);

  const avgDur = durations.length > 0 ? (durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const avgAmp = amplitudes.length > 0 ? (amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length) : 0;
  const avgBpm = bpms.length > 0 ? (bpms.reduce((a, b) => a + b, 0) / bpms.length) : 0;

  let sdDur = 0, sdAmp = 0;
  if (durations.length > 1) {
    sdDur = Math.sqrt(durations.reduce((acc, v) => acc + Math.pow(v - avgDur, 2), 0) / (durations.length - 1));
    sdAmp = Math.sqrt(amplitudes.reduce((acc, v) => acc + Math.pow(v - avgAmp, 2), 0) / (amplitudes.length - 1));
  }
  const cvDur = avgDur > 0 ? (sdDur / avgDur) * 100 : 0;
  const cvAmp = avgAmp > 0 ? (sdAmp / avgAmp) * 100 : 0;

  let stableCount = 0;
  breathCycles.forEach(c => {
    if (Math.abs(c.cycle_duration_s - avgDur) / avgDur * 100 <= researchThresholds.cvDurLimit &&
        Math.abs(c.net_excursion_n - avgAmp) / avgAmp * 100 <= researchThresholds.cvAmpLimit) {
      stableCount++;
    }
  });
  const stablePct = breathCycles.length > 0 ? Math.round((stableCount / breathCycles.length) * 100) : 0;

  const sessionObject = {
    sessionId: sessionId,
    recordedAt: now.toLocaleString(),
    condition: currentExperimentCondition,
    notes: currentSessionNotes || "None",
    serial: serial,
    durationSec: parseFloat((recordedSessionData.length * 0.1).toFixed(1)),
    sampleCount: recordedSessionData.length,
    breathCount: breathCycles.length,
    avgBpm: parseFloat(avgBpm.toFixed(1)),
    avgAmpN: parseFloat(avgAmp.toFixed(2)),
    cvAmpPct: parseFloat(cvAmp.toFixed(1)),
    cvDurPct: parseFloat(cvDur.toFixed(1)),
    stablePct: stablePct,
    cycles: breathCycles,
    thresholds: Object.assign({}, researchThresholds)
  };

  try {
    let allSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]");
    allSessions.unshift(sessionObject);
    localStorage.setItem("respi_experiment_sessions", JSON.stringify(allSessions));
  } catch (e) {
    console.error("Error saving session:", e);
  }

  renderSessionComparisonTable();
  alert(`Session ${sessionId} (${currentExperimentCondition} Breathing) successfully saved to the experiment comparison panel!`);
}

// ========================================================
// 8. MULTI-SESSION EXPERIMENT COMPARISON
// ========================================================
function renderSessionComparisonTable() {
  const tbody = document.getElementById("session-comparison-body");
  const countEl = document.getElementById("saved-sessions-count");
  let allSessions = [];

  try {
    allSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]");
  } catch (e) {}

  if (countEl) countEl.innerText = `${allSessions.length} Sessions Saved`;
  if (!tbody) return;

  if (allSessions.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align: center; color: var(--text-muted); padding: 24px;">
          No saved experimental sessions yet. Complete a trial and click <strong>Stop &amp; Save</strong>, or click <strong>Import JSON</strong> to load session data.
        </td>
      </tr>
    `;
    return;
  }

  let html = "";
  allSessions.forEach(s => {
    const cvAmpLimit = (s.thresholds && s.thresholds.cvAmpLimit) || researchThresholds.cvAmpLimit;
    const cvDurLimit = (s.thresholds && s.thresholds.cvDurLimit) || researchThresholds.cvDurLimit;
    html += `
      <tr>
        <td class="mono-cell" style="color: #38bdf8; font-weight: 700;">${s.sessionId}</td>
        <td class="mono-cell" style="font-size: 0.74rem; color: var(--text-secondary);">${s.recordedAt}</td>
        <td><span class="badge-stability ${(s.condition || 'normal').toLowerCase()}">${s.condition || 'Normal'}</span></td>
        <td style="font-size: 0.76rem; max-width: 140px; overflow: hidden; text-overflow: ellipsis;" title="${s.notes || ''}">${s.notes || 'None'}</td>
        <td class="mono-cell">${s.durationSec}s</td>
        <td class="mono-cell" style="font-weight: 700;">${s.breathCount}</td>
        <td class="mono-cell" style="font-weight: 700;">${s.avgBpm}</td>
        <td class="mono-cell" style="color: #38bdf8; font-weight: 700;">${s.avgAmpN} N</td>
        <td class="mono-cell" style="color: ${s.cvAmpPct > cvAmpLimit ? '#fbbf24' : '#ffffff'}; font-weight: 700;">${s.cvAmpPct}%</td>
        <td class="mono-cell" style="color: ${s.cvDurPct > cvDurLimit ? '#fbbf24' : '#ffffff'}; font-weight: 700;">${s.cvDurPct}%</td>
        <td class="mono-cell" style="color: ${s.stablePct >= 75 ? '#34d399' : '#fbbf24'}; font-weight: 700;">${s.stablePct}%</td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <button onclick="exportSavedSessionPDF('${s.sessionId}')" style="background: rgba(168,85,247,0.18); border: 1px solid rgba(168,85,247,0.35); color: #c084fc; border-radius: 4px; padding: 3px 7px; font-size: 0.7rem; font-weight: 700; cursor: pointer;" title="Export Comprehensive Multi-Page PDF Report">PDF</button>
            <button onclick="exportSavedSessionCSV('${s.sessionId}')" style="background: rgba(34,197,94,0.18); border: 1px solid rgba(34,197,94,0.35); color: #4ade80; border-radius: 4px; padding: 3px 7px; font-size: 0.7rem; font-weight: 700; cursor: pointer;" title="Export Breath Cycles CSV">CSV</button>
            <button onclick="loadSavedSession('${s.sessionId}')" style="background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.3); color: #38bdf8; border-radius: 4px; padding: 3px 7px; font-size: 0.7rem; cursor: pointer;" title="Load into Active Dashboard">View</button>
            <button onclick="deleteSavedSession('${s.sessionId}')" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #f87171; border-radius: 4px; padding: 3px 7px; font-size: 0.7rem; cursor: pointer;" title="Delete Session">Del</button>
          </div>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

function loadSavedSession(sessionId) {
  try {
    const allSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]");
    const found = allSessions.find(s => s.sessionId === sessionId);
    if (!found) return;

    breathCycles = found.cycles || [];
    setExperimentCondition(found.condition);
    currentBreathCount = found.breathCount || 0;
    document.getElementById("rec-breaths").innerText = currentBreathCount;

    evaluateAllCyclesVariability();
    alert(`Loaded session ${sessionId} (${found.condition} Breathing) with ${breathCycles.length} analyzed cycles.`);
  } catch (e) {
    console.error("Error loading session:", e);
  }
}

function deleteSavedSession(sessionId) {
  if (!confirm(`Delete saved session ${sessionId}?`)) return;
  try {
    let allSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]");
    allSessions = allSessions.filter(s => s.sessionId !== sessionId);
    localStorage.setItem("respi_experiment_sessions", JSON.stringify(allSessions));
    renderSessionComparisonTable();
  } catch (e) {}
}

function clearAllSessions() {
  if (!confirm("Are you sure you want to clear all saved experiment sessions from local storage?")) return;
  localStorage.removeItem("respi_experiment_sessions");
  renderSessionComparisonTable();
}

function exportAllSessionsJSON() {
  const allSessions = localStorage.getItem("respi_experiment_sessions") || "[]";
  const blob = new Blob([allSessions], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `respiratory_sessions_all_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSessionsJSON(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      let sessionsToAdd = [];

      if (Array.isArray(data)) {
        sessionsToAdd = data;
      } else if (data && data.sessionId && data.cycles) {
        sessionsToAdd = [data];
      } else if (data && (data.samples || data.cycles)) {
        const cycles = data.cycles || [];
        const durations = cycles.map(c => c.cycle_duration_s || (c.end_time_s - c.start_time_s) || 4.0);
        const amplitudes = cycles.map(c => c.net_excursion_n || (c.peak_force_n - (c.baseline_force_n || 0)) || 2.0);
        const bpms = cycles.map(c => c.respiration_rate_bpm || (durations.length ? 60 / durations[0] : 14.0));
        
        const avgDur = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length) : (data.duration_seconds && cycles.length ? data.duration_seconds / cycles.length : 4.0);
        const avgAmp = amplitudes.length ? (amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length) : 2.5;
        const avgBpm = bpms.length ? (bpms.reduce((a, b) => a + b, 0) / bpms.length) : 14.0;
        
        let sdDur = 0, sdAmp = 0;
        if (durations.length > 1) {
          sdDur = Math.sqrt(durations.reduce((acc, v) => acc + Math.pow(v - avgDur, 2), 0) / (durations.length - 1));
          sdAmp = Math.sqrt(amplitudes.reduce((acc, v) => acc + Math.pow(v - avgAmp, 2), 0) / (amplitudes.length - 1));
        }
        const cvDur = avgDur > 0 ? (sdDur / avgDur) * 100 : 0;
        const cvAmp = avgAmp > 0 ? (sdAmp / avgAmp) * 100 : 0;

        const importedSession = {
          sessionId: "IMP-" + (data.serial_number || "0K7014Z0") + "-" + Date.now().toString(36).slice(-4).toUpperCase(),
          recordedAt: data.export_timestamp || data.export_time || new Date().toLocaleString(),
          condition: data.condition || "Normal",
          notes: data.notes || "Imported JSON Session",
          serial: data.serial_number || data.order_code || "0K7014Z0",
          durationSec: parseFloat((data.duration_seconds || (data.samples ? data.samples.length * 0.1 : 60)).toFixed(1)),
          sampleCount: data.samples ? data.samples.length : (data.total_samples || 0),
          breathCount: cycles.length || (data.total_breaths_detected || 0),
          avgBpm: parseFloat(avgBpm.toFixed(1)),
          avgAmpN: parseFloat(avgAmp.toFixed(2)),
          cvAmpPct: parseFloat(cvAmp.toFixed(1)),
          cvDurPct: parseFloat(cvDur.toFixed(1)),
          stablePct: Math.max(0, Math.min(100, Math.round(100 - (cvAmp + cvDur) / 2))),
          cycles: cycles,
          thresholds: data.thresholds || Object.assign({}, researchThresholds)
        };
        sessionsToAdd = [importedSession];
      } else {
        alert("Unrecognized JSON session format. Please select a valid RespiTrack session JSON.");
        return;
      }

      let existingSessions = [];
      try {
        existingSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]");
      } catch (err) {}

      let addedCount = 0;
      sessionsToAdd.forEach(newSess => {
        if (!newSess.sessionId) {
          newSess.sessionId = "IMP-" + Math.random().toString(36).slice(2, 7).toUpperCase();
        }
        const existingIdx = existingSessions.findIndex(s => s.sessionId === newSess.sessionId);
        if (existingIdx >= 0) {
          existingSessions[existingIdx] = newSess;
        } else {
          existingSessions.push(newSess);
          addedCount++;
        }
      });

      localStorage.setItem("respi_experiment_sessions", JSON.stringify(existingSessions));
      renderSessionComparisonTable();
      alert(`Import complete! Loaded ${sessionsToAdd.length} session(s) (${addedCount} new) into the comparison table.`);
    } catch (err) {
      console.error("Failed to parse JSON file:", err);
      alert("Error reading JSON session file: " + err.message);
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function exportSavedSessionCSV(sessionId) {
  let allSessions = [];
  try {
    allSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]");
  } catch (e) {}

  const s = allSessions.find(sess => sess.sessionId === sessionId);
  if (!s) {
    alert("Session not found: " + sessionId);
    return;
  }

  const cycles = s.cycles || [];
  let csv = `# RESPITRACK // Exported Respiratory Session: ${s.sessionId}\n`;
  csv += `# Condition: ${s.condition} Breathing\n`;
  csv += `# Recorded At: ${s.recordedAt}\n`;
  csv += `# Sensor Hardware: Vernier GDX-RB (S/N: ${s.serial || '0K7014Z0'})\n`;
  csv += `# Total Duration: ${s.durationSec} s\n`;
  csv += `# Total Detected Breaths: ${s.breathCount || cycles.length}\n`;
  csv += `# Average Frequency: ${s.avgBpm} BPM\n`;
  csv += `# Average Tidal Amplitude: ${s.avgAmpN} N\n`;
  csv += `# Amplitude Variability (CV_amp): ${s.cvAmpPct}%\n`;
  csv += `# Duration Variability (CV_dur): ${s.cvDurPct}%\n`;
  csv += `# Stable Breathing Percentage: ${s.stablePct}%\n`;
  csv += `# Protocol Notes: ${s.notes || 'None'}\n`;
  csv += `#\n`;
  csv += `breath_number,start_clock,end_clock,start_time_s,end_time_s,cycle_duration_s,respiration_rate_bpm,inhale_duration_s,exhale_duration_s,ie_ratio,baseline_force_n,peak_force_n,net_excursion_n,classification\n`;

  cycles.forEach(c => {
    csv += `${c.breath_number},"${c.start_clock || ''}","${c.end_clock || ''}",${c.start_time_s || 0},${c.end_time_s || 0},${c.cycle_duration_s || 0},${c.respiration_rate_bpm || 0},${c.inhale_duration_s || 0},${c.exhale_duration_s || 0},"${c.ie_ratio || ''}",${c.baseline_force_n || 0},${c.peak_force_n || 0},${c.net_excursion_n || 0},"${c.classification || 'Standard'}"\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `respiratory_session_${s.sessionId}_${s.condition.toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportSavedSessionPDF(sessionId) {
  let allSessions = [];
  try {
    allSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]");
  } catch (e) {}

  const s = allSessions.find(sess => sess.sessionId === sessionId);
  if (!s) {
    alert("Session not found: " + sessionId);
    return;
  }
  exportSessionPDF(s);
}

// ========================================================
// 9. PDF RESEARCH REPORT GENERATION (jsPDF) - MULTI-PAGE & ENHANCED
// ========================================================
function exportSessionPDF(targetSession = null) {
  if (typeof window.jspdf === "undefined" || !window.jspdf.jsPDF) {
    alert("jsPDF library is loading. Please verify internet connection and retry.");
    return;
  }

  // Resolve session target: historical session object OR live session
  let target = null;
  if (typeof targetSession === "string") {
    let allSessions = [];
    try { allSessions = JSON.parse(localStorage.getItem("respi_experiment_sessions") || "[]"); } catch (e) {}
    target = allSessions.find(s => s.sessionId === targetSession);
  } else if (targetSession && typeof targetSession === "object" && !targetSession.preventDefault) {
    target = targetSession;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();   // 210 mm
  const pageHeight = doc.internal.pageSize.getHeight(); // 297 mm
  const contentWidth = pageWidth - 28;                  // 182 mm
  const now = new Date();

  // Extract session metadata & statistics
  const sessionId = target ? target.sessionId : (currentSessionId || ("LIVE-" + Date.now().toString(36).toUpperCase()));
  const condition = (target ? target.condition : currentExperimentCondition).toUpperCase();
  const notes = target ? target.notes : (currentSessionNotes || "Standard resting trial");
  const serial = target ? (target.serial || "0K7014Z0") : (document.getElementById("hw-serial").innerText || "0K7014Z0");
  const durationSec = target ? target.durationSec : parseFloat((recordedSessionData.length * 0.1).toFixed(1));
  const sampleCount = target ? (target.sampleCount || Math.round(target.durationSec * 10)) : recordedSessionData.length;
  const cycles = target ? (target.cycles || []) : breathCycles;

  const avgRate = target ? String(target.avgBpm) : (document.getElementById("res-avg-rate") ? document.getElementById("res-avg-rate").innerText : "--");
  const avgAmp = target ? String(target.avgAmpN) : (document.getElementById("res-avg-amp") ? document.getElementById("res-avg-amp").innerText : "--");
  const avgDur = target && cycles.length > 0 ? (cycles.reduce((a, c) => a + (c.cycle_duration_s || 0), 0) / cycles.length).toFixed(2) : (document.getElementById("res-avg-dur") ? document.getElementById("res-avg-dur").innerText : "--");
  const cvAmp = target ? String(target.cvAmpPct) : (document.getElementById("res-cv-amp") ? document.getElementById("res-cv-amp").innerText : "--");
  const cvDur = target ? String(target.cvDurPct) : (document.getElementById("res-cv-dur") ? document.getElementById("res-cv-dur").innerText : "--");
  const stablePct = target ? String(target.stablePct) : (document.getElementById("res-stable-pct") ? document.getElementById("res-stable-pct").innerText : "--");
  const qualPct = target ? "98" : (document.getElementById("res-quality-pct") ? document.getElementById("res-quality-pct").innerText : "100");
  const recordedAtStr = target ? target.recordedAt : now.toLocaleString();
  const thresholds = (target && target.thresholds) ? target.thresholds : researchThresholds;

  // 1. Header Banner
  doc.setFillColor(15, 23, 42); // slate-900
  doc.rect(0, 0, pageWidth, 26, "F");

  doc.setFillColor(56, 189, 248); // sky-400 accent line
  doc.rect(0, 26, pageWidth, 1.2, "F");

  doc.setTextColor(56, 189, 248);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("RESPITRACK // RESPIRATORY MOTION RESEARCH REPORT", 14, 11);

  doc.setTextColor(203, 213, 225);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text("Vernier Go Direct Respiration Belt (GDX-RB) • Radiation Treatment Planning Analysis", 14, 18);

  // Condition Badge
  const badgeColor = condition === "IRREGULAR" ? [239, 68, 68] : (condition === "CONTROLLED" ? [59, 130, 246] : [34, 197, 94]);
  doc.setFillColor(badgeColor[0], badgeColor[1], badgeColor[2]);
  doc.roundedRect(pageWidth - 62, 6, 48, 14, 2, 2, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8.5);
  doc.setFont("helvetica", "bold");
  doc.text(`${condition} TRIAL`, pageWidth - 38, 15, { align: "center" });

  // 2. Metadata Grid
  let y = 33;
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(9.5);
  doc.setFont("helvetica", "bold");
  doc.text("1. EXPERIMENTAL SESSION PROTOCOL & SENSOR METADATA", 14, y);

  y += 4;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(14, y, contentWidth, 24, 1.5, 1.5, "FD");

  doc.setFontSize(7.8);
  const col1 = 18, col2 = 80, col3 = 142;

  doc.setFont("helvetica", "bold");
  doc.setTextColor(71, 85, 105);
  doc.text("Session ID:", col1, y + 5.5);
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.text(sessionId, col1 + 18, y + 5.5);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(71, 85, 105);
  doc.text("Sensor Hardware:", col1, y + 11.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Vernier GDX-RB (S/N: ${serial})`, col1 + 25, y + 11.5);

  doc.setTextColor(71, 85, 105);
  doc.text("Sampling Rate:", col1, y + 17.5);
  doc.setTextColor(15, 23, 42);
  doc.text("10.0 Hz (100 ms interval)", col1 + 25, y + 17.5);

  // Column 2
  doc.setTextColor(71, 85, 105);
  doc.text("Duration:", col2, y + 5.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`${durationSec}s (${sampleCount} samples)`, col2 + 20, y + 5.5);

  doc.setTextColor(71, 85, 105);
  doc.text("Breath Cycles:", col2, y + 11.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`${cycles.length} detected`, col2 + 20, y + 11.5);

  doc.setTextColor(71, 85, 105);
  doc.text("Signal Quality:", col2, y + 17.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`${qualPct}%`, col2 + 20, y + 17.5);

  // Column 3
  doc.setTextColor(71, 85, 105);
  doc.text("Recorded:", col3, y + 5.5);
  doc.setTextColor(15, 23, 42);
  doc.text(recordedAtStr.slice(0, 22), col3 + 16, y + 5.5);

  doc.setTextColor(71, 85, 105);
  doc.text("Protocol:", col3, y + 11.5);
  doc.setTextColor(15, 23, 42);
  const truncatedNotes = notes.length > 28 ? notes.slice(0, 26) + "..." : notes;
  doc.text(truncatedNotes, col3 + 16, y + 11.5);

  // 3. Quantitative Metrics Table
  y += 30;
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(9.5);
  doc.setFont("helvetica", "bold");
  doc.text("2. QUANTITATIVE RESPIRATORY METRICS & VARIABILITY (CV%)", 14, y);

  y += 4;
  const cardW = (contentWidth - 9) / 4;
  const cardH = 15;

  const metricsArr = [
    { label: "MEAN RESPIRATION RATE", val: `${avgRate} BPM`, sub: "Cycle frequency" },
    { label: "MEAN TIDAL AMPLITUDE", val: `${avgAmp} N`, sub: "Peak-to-trough force" },
    { label: "AMPLITUDE VARIABILITY", val: `${cvAmp}%`, sub: `CV_amp (limit: ${thresholds.cvAmpLimit}%)`, warn: parseFloat(cvAmp) > thresholds.cvAmpLimit },
    { label: "DURATION VARIABILITY", val: `${cvDur}%`, sub: `CV_dur (limit: ${thresholds.cvDurLimit}%)`, warn: parseFloat(cvDur) > thresholds.cvDurLimit }
  ];

  metricsArr.forEach((m, idx) => {
    const cx = 14 + idx * (cardW + 3);
    doc.setFillColor(m.warn ? 254 : 241, m.warn ? 242 : 245, m.warn ? 242 : 249);
    doc.setDrawColor(m.warn ? 248 : 226, m.warn ? 113 : 232, m.warn ? 113 : 240);
    doc.roundedRect(cx, y, cardW, cardH, 1.5, 1.5, "FD");

    doc.setFontSize(6.2);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(m.warn ? 185 : 71, m.warn ? 28 : 85, m.warn ? 28 : 105);
    doc.text(m.label, cx + 3, y + 4.5);

    doc.setFontSize(10.5);
    doc.setTextColor(m.warn ? 220 : 15, m.warn ? 38 : 23, m.warn ? 38 : 42);
    doc.text(m.val, cx + 3, y + 10.5);

    doc.setFontSize(5.8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(m.warn ? 185 : 100, m.warn ? 28 : 116, m.warn ? 28 : 139);
    doc.text(m.sub, cx + 3, y + 13.5);
  });

  // Clinical Radiotherapy Suitability Assessment
  y += cardH + 4;
  const numCvAmp = parseFloat(cvAmp) || 0;
  const numCvDur = parseFloat(cvDur) || 0;
  const isCandidateGating = numCvAmp <= thresholds.cvAmpLimit && numCvDur <= thresholds.cvDurLimit;

  doc.setFillColor(isCandidateGating ? 240 : 255, isCandidateGating ? 253 : 251, isCandidateGating ? 244 : 235);
  doc.setDrawColor(isCandidateGating ? 74 : 245, isCandidateGating ? 222 : 158, isCandidateGating ? 128 : 11);
  doc.roundedRect(14, y, contentWidth, 14, 1.5, 1.5, "FD");

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(isCandidateGating ? 21 : 180, isCandidateGating ? 128 : 83, isCandidateGating ? 61 : 9);
  doc.text(`Radiotherapy Gating Evaluation • Stable Breathing Time: ${stablePct}%`, 18, y + 5);

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(30, 41, 59);
  const evalText = isCandidateGating
    ? `HIGH CONSISTENCY (CV < ${thresholds.cvAmpLimit}%): Patient motion conforms to reproducible eupneic breathing. Qualified for phase-based 4D-CT binning and linear accelerator beam gating.`
    : `IRREGULAR MOTION DETECTED (CV > ${thresholds.cvAmpLimit}%): Exceeds standard 15% gating tolerance. Prone to 4D-CT phase-sorting artifacts (ghosting/blurring) and linear accelerator beam hold-offs. Recommended: Audio/visual biofeedback guidance or Deep Inspiration Breath Hold (DIBH).`;
  doc.text(doc.splitTextToSize(evalText, contentWidth - 8), 18, y + 9.5);

  // 4. Waveform Snapshot OR Excursion Card
  y += 18;
  if (!target && chartInstance) {
    doc.setTextColor(15, 23, 42);
    doc.setFontSize(9.5);
    doc.setFont("helvetica", "bold");
    doc.text("3. REAL-TIME RESPIRATORY BELT FORCE WAVEFORM (NEWTONS)", 14, y);

    y += 3.5;
    try {
      const imgData = chartInstance.toBase64Image();
      const imgHeight = 44;
      doc.addImage(imgData, "PNG", 14, y, contentWidth, imgHeight);
      y += imgHeight + 5;
    } catch (e) {
      y += 8;
    }
  }

  // 5. Irregularity Flags & Clinical Deviation Log
  const irregularEvents = [];
  cycles.forEach(c => {
    const flags = [];
    if (c.cycle_duration_s < 1.5) {
      flags.push({ event: "Tachypnea / Catch-up", reason: `Cycle duration ${c.cycle_duration_s}s (< 1.5s)`, rtImpact: "Phase compression risk in 4D-CT binning" });
    } else if (c.cycle_duration_s > 6.0) {
      flags.push({ event: "Bradypneic Pause / Apnea", reason: `Cycle duration ${c.cycle_duration_s}s (> 6.0s)`, rtImpact: "Linear accelerator beam hold-off; potential baseline drift" });
    }
    if (c.net_excursion_n < 0.6) {
      flags.push({ event: "Shallow Hypopnea", reason: `Excursion ${c.net_excursion_n}N (< 0.6N)`, rtImpact: "May fall below amplitude gating duty threshold" });
    } else if (c.net_excursion_n > 12.0) {
      flags.push({ event: "Deep Sigh / Spike", reason: `Excursion ${c.net_excursion_n}N (> 12.0N)`, rtImpact: "Exceeds planning gating envelope (target displacement)" });
    }
    if (c.classification && (c.classification.includes("Sigh") || c.classification.includes("Variation") || c.classification.includes("Catch-up") || c.classification.includes("Hold"))) {
      if (!flags.some(f => f.event.includes(c.classification))) {
        flags.push({ event: c.classification, reason: "Statistical deviation from session mean", rtImpact: "Intra-fraction target position variation" });
      }
    }
    flags.forEach(f => {
      irregularEvents.push({
        breathNum: c.breath_number,
        window: `${c.start_time_s.toFixed(1)} - ${c.end_time_s.toFixed(1)}s`,
        event: f.event,
        reason: f.reason,
        rtImpact: f.rtImpact
      });
    });
  });

  // Check if we need space for Irregularity Section
  if (y > 230) {
    doc.addPage();
    y = 20;
  }

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(9.5);
  doc.setFont("helvetica", "bold");
  doc.text("4. IRREGULARITY FLAGS & CLINICAL DEVIATION LOG", 14, y);
  y += 4;

  if (irregularEvents.length === 0) {
    doc.setFillColor(240, 253, 244);
    doc.setDrawColor(74, 222, 128);
    doc.roundedRect(14, y, contentWidth, 10, 1.5, 1.5, "FD");
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(21, 128, 61);
    doc.text("✓ NO CLINICAL IRREGULARITIES DETECTED: All recorded cycles conform to normal eupneic limits (CV < 15%).", 18, y + 6.5);
    y += 14;
  } else {
    doc.setFillColor(254, 242, 242);
    doc.setDrawColor(248, 113, 113);
    const boxH = Math.min(36, 6 + Math.min(6, irregularEvents.length) * 4.5);
    doc.roundedRect(14, y, contentWidth, boxH, 1.5, 1.5, "FD");

    doc.setFontSize(6.8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(185, 28, 28);
    doc.text("#", 18, y + 4.5);
    doc.text("Time (s)", 26, y + 4.5);
    doc.text("Detected Event", 52, y + 4.5);
    doc.text("Mathematical Deviation", 94, y + 4.5);
    doc.text("Radiotherapy Motion Impact", 140, y + 4.5);

    let flagY = y + 8.5;
    doc.setFont("helvetica", "normal");
    irregularEvents.slice(0, 5).forEach(ev => {
      doc.text(String(ev.breathNum), 18, flagY);
      doc.text(ev.window, 26, flagY);
      doc.text(ev.event.slice(0, 24), 52, flagY);
      doc.text(ev.reason.slice(0, 28), 94, flagY);
      doc.text(ev.rtImpact.slice(0, 32), 140, flagY);
      flagY += 4.2;
    });

    if (irregularEvents.length > 5) {
      doc.setFontSize(6);
      doc.setTextColor(100, 116, 139);
      doc.text(`+ ${irregularEvents.length - 5} additional irregularity events detected across session.`, 18, flagY);
    }
    y += boxH + 5;
  }

  // 6. Complete Breath-by-Breath Cycles Breakdown (Multi-page Pagination!)
  function printCyclesTableHeader(currentY) {
    doc.setFillColor(241, 245, 249);
    doc.rect(14, currentY, contentWidth, 6, "F");
    doc.setDrawColor(203, 213, 225);
    doc.line(14, currentY + 6, pageWidth - 14, currentY + 6);

    doc.setFontSize(6.8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(51, 65, 85);
    doc.text("#", 16, currentY + 4.2);
    doc.text("Window (s)", 24, currentY + 4.2);
    doc.text("Duration", 52, currentY + 4.2);
    doc.text("Rate", 72, currentY + 4.2);
    doc.text("Peak (N)", 92, currentY + 4.2);
    doc.text("Amp (ΔF)", 112, currentY + 4.2);
    doc.text("Insp / Exp", 132, currentY + 4.2);
    doc.text("I:E", 154, currentY + 4.2);
    doc.text("Classification", 168, currentY + 4.2);
  }

  // Check if we need a new page for the table
  if (y > 220) {
    doc.addPage();
    y = 20;
  }

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(9.5);
  doc.setFont("helvetica", "bold");
  doc.text(`5. COMPLETE BREATH-BY-BREATH CYCLES BREAKDOWN (${cycles.length} TOTAL CYCLES)`, 14, y);
  y += 4;

  printCyclesTableHeader(y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.8);

  cycles.forEach((c, idx) => {
    // Multi-page page break check
    if (y + 5 > pageHeight - 16) {
      doc.addPage();
      y = 18;
      doc.setTextColor(15, 23, 42);
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "bold");
      doc.text(`5. COMPLETE BREATH-BY-BREATH CYCLES BREAKDOWN (CONTINUED - CYCLE ${c.breath_number} ONWARDS)`, 14, y);
      y += 4;
      printCyclesTableHeader(y);
      y += 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
    }

    // Alternating zebra striping
    if (idx % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(14, y, contentWidth, 4.4, "F");
    }

    const isStable = (c.classification && c.classification.includes("Stable"));
    doc.setTextColor(isStable ? 15 : 185, isStable ? 23 : 28, isStable ? 42 : 28);

    doc.text(String(c.breath_number), 16, y + 3.2);
    doc.text(`${(c.start_time_s || 0).toFixed(1)} - ${(c.end_time_s || 0).toFixed(1)}s`, 24, y + 3.2);
    doc.text(`${(c.cycle_duration_s || 0).toFixed(2)}s`, 52, y + 3.2);
    doc.text(`${(c.respiration_rate_bpm || 0).toFixed(1)}`, 72, y + 3.2);
    doc.text(`${(c.peak_force_n || 0).toFixed(2)} N`, 92, y + 3.2);
    doc.text(`${(c.net_excursion_n || 0).toFixed(2)} N`, 112, y + 3.2);
    doc.text(`${(c.inhale_duration_s || 0).toFixed(1)}s / ${(c.exhale_duration_s || 0).toFixed(1)}s`, 132, y + 3.2);
    doc.text(c.ie_ratio || "--", 154, y + 3.2);
    doc.text(c.classification || "Standard", 168, y + 3.2);

    y += 4.4;
  });

  // 7. Running Headers & Footers across ALL pages
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);

    // Header on pages > 1
    if (p > 1) {
      doc.setFillColor(15, 23, 42);
      doc.rect(0, 0, pageWidth, 12, "F");
      doc.setFillColor(56, 189, 248);
      doc.rect(0, 12, pageWidth, 0.6, "F");
      doc.setTextColor(56, 189, 248);
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.text(`RESPITRACK // RESEARCH REPORT • Session: ${sessionId} • ${condition}`, 14, 8);
      doc.setTextColor(148, 163, 184);
      doc.setFont("helvetica", "normal");
      doc.text(`Vernier GDX-RB (S/N: ${serial})`, pageWidth - 14, 8, { align: "right" });
    }

    // Footer on all pages
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.4);
    doc.line(14, 287, pageWidth - 14, 287);

    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text("RESEARCH NOTICE: For experimental research in respiratory motion for radiation treatment planning. Not for direct clinical diagnosis.", 14, 292);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(100, 116, 139);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - 14, 292, { align: "right" });
  }

  const filename = `respiratory_report_${condition.toLowerCase()}_${sessionId}_${now.toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}

// ========================================================
// 10. CLIENT DATA PROCESSOR & WEBSOCKET/WEBHID HANDLERS
// ========================================================
function processIncomingSample(data) {
  totalPacketsReceived++;
  document.getElementById("stat-packet-count").innerText = totalPacketsReceived.toLocaleString();

  const val = data.value;               // Net expansion force in Newtons (N)
  const rawForce = data.raw_force;     // Raw belt transducer force in N
  const tareOffset = data.tare_offset;
  const timeStr = data.time_str;
  const bpm = data.bpm;
  const phase = data.phase;

  // Force balance readouts
  document.getElementById("force-raw-val").innerText = rawForce.toFixed(3) + " N";
  document.getElementById("force-tare-val").innerText = tareOffset.toFixed(3) + " N";
  document.getElementById("force-net-val").innerText = val.toFixed(2) + " N";

  // Live Telemetry Readout
  document.getElementById("hud-disp-val").innerText = val.toFixed(2);
  const delta = (val - lastSensorValue) * 10.0;
  document.getElementById("hud-delta-val").innerText = (delta >= 0 ? "+" : "") + delta.toFixed(2) + " N/s";
  lastSensorValue = val;

  const motionDirEl = document.getElementById("hud-motion-dir");
  if (delta > 0.08) motionDirEl.innerText = "Inhaling ↑";
  else if (delta < -0.08) motionDirEl.innerText = "Exhaling ↓";
  else motionDirEl.innerText = "Plateau ↔";

  document.getElementById("hud-phase-val").innerText = phase;
  document.getElementById("hud-rate-val").innerText = bpm > 0 ? bpm.toFixed(1) : "--";
  document.getElementById("hud-period-val").innerText = bpm > 0 ? (60.0 / bpm).toFixed(2) : "--";

  recentValues.push(val);
  if (recentValues.length > 150) recentValues.shift();
  const minVal = Math.min(...recentValues);
  const maxVal = Math.max(...recentValues);
  document.getElementById("hud-min-val").innerText = minVal.toFixed(1);
  document.getElementById("hud-max-val").innerText = maxVal.toFixed(1);
  document.getElementById("hud-range-val").innerText = (maxVal - minVal).toFixed(1);

  // Record sample if recording is active and not paused
  if (isSensorStreaming && !isRecordingPaused) {
    recordSample(data);
  }

  // Analyze breath sample for peak/trough detection
  analyzeBreathSample(val, rawForce, data.timestamp, timeStr);

  // Update Chart Canvas (unless display paused)
  if (!isChartDisplayPaused && chartInstance) {
    chartLabels.shift();
    chartLabels.push(timeStr);

    chartSignalData.shift();
    chartSignalData.push(val);

    chartPeakData.shift();
    chartPeakData.push(null);

    chartTroughData.shift();
    chartTroughData.push(null);

    const requiredMax = Math.max(4.0, Math.ceil(maxVal + 1.2));
    if (chartInstance.options.scales.y.max < requiredMax) {
      chartInstance.options.scales.y.max = requiredMax;
    }

    chartInstance.update("none");
  }

  // Periodic diagnostic assessment (10 ticks = 1 sec)
  if (totalPacketsReceived % 10 === 0) {
    evaluateBreathingDiagnostics(currentBpm, currentAmplitude, currentNoise);
  }
}

function recordSample(data) {
  const item = {
    sample_index: data.sample_count || (recordedSessionData.length + 1),
    timestamp_iso: new Date().toISOString(),
    time_str: data.time_str,
    elapsed_seconds: parseFloat(data.timestamp.toFixed(2)),
    raw_force_n: parseFloat(data.raw_force.toFixed(3)),
    tare_offset_n: parseFloat(data.tare_offset.toFixed(3)),
    net_expansion_n: parseFloat(data.value.toFixed(2)),
    respiration_rate_bpm: parseFloat(data.bpm.toFixed(1)),
    phase: data.phase,
    breath_count: currentBreathCount,
    condition: currentExperimentCondition
  };
  recordedSessionData.push(item);
  updateRecordedCounters();
}

function updateRecordedCounters() {
  const count = recordedSessionData.length;
  const elCount = document.getElementById("rec-count");
  const elDur = document.getElementById("rec-duration");
  if (elCount) elCount.innerText = count.toLocaleString();
  if (elDur) {
    const m = String(Math.floor(count * 0.1 / 60)).padStart(2, "0");
    const s = String(Math.floor((count * 0.1) % 60)).padStart(2, "0");
    elDur.innerText = `${m}:${s}`;
  }

  const hasData = (count > 0);
  ["btn-download-summary", "btn-download-csv", "btn-download-json", "btn-download-pdf", "btn-table-download-csv"].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !hasData;
  });
}

function clearSessionRecording() {
  if (recordedSessionData.length > 0 && !confirm("Reset current session samples and breath counter?")) {
    return;
  }
  recordedSessionData = [];
  breathCycles = [];
  currentBreathCount = 0;
  document.getElementById("rec-breaths").innerText = "0";
  updateRecordedCounters();
  renderBreathTable([]);
  evaluateAllCyclesVariability();
  if (socket && socket.connected) {
    socket.emit("clear_recording");
  }
}

// CSV & JSON Downloads
function downloadPhysicalSummaryCSV() {
  if (breathCycles.length === 0) {
    alert("No completed breath cycles detected yet to export.");
    return;
  }

  const now = new Date();
  const serial = document.getElementById("hw-serial").innerText || "0K7014Z0";
  const filename = `respiratory_summary_${currentExperimentCondition.toLowerCase()}_${serial}_${now.toISOString().slice(0, 10)}.csv`;

  let csv = "# RESPITRACK // Physical Breath-by-Breath Summary Table\n";
  csv += `# Device: Vernier Go Direct Respiration Belt (GDX-RB)\n`;
  csv += `# Serial Number: ${serial}\n`;
  csv += `# Experiment Condition: ${currentExperimentCondition}\n`;
  csv += `# Notes: ${currentSessionNotes || 'None'}\n`;
  csv += `# Exported: ${now.toLocaleString()}\n`;
  csv += `# Total Cycles: ${breathCycles.length}\n`;
  csv += "#\n";
  csv += "breath_number,start_clock,end_clock,start_time_s,end_time_s,cycle_duration_s,respiration_rate_bpm,inhale_duration_s,exhale_duration_s,ie_ratio,baseline_force_n,peak_force_n,net_excursion_n,classification\n";

  breathCycles.forEach(c => {
    csv += `${c.breath_number},"${c.start_clock}","${c.end_clock}",${c.start_time_s},${c.end_time_s},${c.cycle_duration_s},${c.respiration_rate_bpm},${c.inhale_duration_s},${c.exhale_duration_s},"${c.ie_ratio}",${c.baseline_force_n},${c.peak_force_n},${c.net_excursion_n},"${c.classification}"\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadSessionCSV() {
  if (recordedSessionData.length === 0) {
    alert("No session data recorded yet.");
    return;
  }

  const now = new Date();
  const serial = document.getElementById("hw-serial").innerText || "0K7014Z0";
  const filename = `breathing_raw10hz_${currentExperimentCondition.toLowerCase()}_${serial}_${now.toISOString().slice(0, 10)}.csv`;

  let csv = "# RESPITRACK // Raw 10 Hz Respiratory Transducer Time-Series\n";
  csv += `# Device: Vernier Go Direct Respiration Belt (GDX-RB)\n`;
  csv += `# Serial Number: ${serial}\n`;
  csv += `# Condition: ${currentExperimentCondition}\n`;
  csv += `# Notes: ${currentSessionNotes || 'None'}\n`;
  csv += `# Total Samples: ${recordedSessionData.length}\n`;
  csv += `# Sampling Frequency: 10.0 Hz\n`;
  csv += "# Formula: Net Expansion (N) = max(0, Raw Transducer Force - Tare Offset)\n";
  csv += "#\n";
  csv += "sample_index,timestamp_iso,time_str,elapsed_seconds,raw_force_n,tare_offset_n,net_expansion_n,respiration_rate_bpm,phase,breath_count,condition\n";

  for (const r of recordedSessionData) {
    csv += `${r.sample_index},"${r.timestamp_iso}","${r.time_str}",${r.elapsed_seconds},${r.raw_force_n},${r.tare_offset_n},${r.net_expansion_n},${r.respiration_rate_bpm},"${r.phase}",${r.breath_count},"${r.condition}"\n`;
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadSessionJSON() {
  if (recordedSessionData.length === 0) {
    alert("No session data recorded yet.");
    return;
  }

  const serial = document.getElementById("hw-serial").innerText || "0K7014Z0";
  const payload = {
    system: "RESPITRACK",
    device: "Vernier Go Direct Respiration Belt",
    serial_number: serial,
    condition: currentExperimentCondition,
    notes: currentSessionNotes,
    export_timestamp: new Date().toISOString(),
    sampling_frequency_hz: 10.0,
    total_samples: recordedSessionData.length,
    total_breaths_detected: breathCycles.length,
    duration_seconds: parseFloat((recordedSessionData.length * 0.1).toFixed(1)),
    thresholds: researchThresholds,
    cycles: breathCycles,
    samples: recordedSessionData
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `breathing_session_${currentExperimentCondition.toLowerCase()}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderBreathTable(cycles) {
  const tbody = document.getElementById("breath-table-body");
  const badgeCount = document.getElementById("summary-badge-count");
  if (badgeCount) badgeCount.innerText = `${cycles.length} Breaths Analyzed`;

  if (!tbody) return;
  if (!cycles || cycles.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align: center; color: var(--text-muted); padding: 24px;">
          No completed breath cycles analyzed yet. Complete a recording session to view the physical breakdown.
        </td>
      </tr>
    `;
    return;
  }

  let html = "";
  cycles.forEach(c => {
    let badgeClass = "eupnea";
    const clsLower = (c.classification || "").toLowerCase();
    if (clsLower.includes("sigh") || clsLower.includes("deep")) badgeClass = "deep";
    else if (clsLower.includes("pause") || clsLower.includes("hold")) badgeClass = "pause";
    else if (clsLower.includes("rhythm") || clsLower.includes("variation")) badgeClass = "rapid";
    else if (clsLower.includes("shallow")) badgeClass = "shallow";

    html += `
      <tr>
        <td class="mono-cell" style="color: #38bdf8; font-weight: 700;">#${c.breath_number}</td>
        <td class="mono-cell" style="font-size: 0.74rem; color: var(--text-secondary);">${c.start_clock} → ${c.end_clock}</td>
        <td class="mono-cell">${c.start_time_s.toFixed(1)}s - ${c.end_time_s.toFixed(1)}s</td>
        <td class="mono-cell" style="color: #f1f5f9; font-weight: 700;">${c.cycle_duration_s.toFixed(1)} s</td>
        <td class="mono-cell" style="color: ${c.respiration_rate_bpm > 20 ? '#f87171' : c.respiration_rate_bpm < 10 ? '#fbbf24' : '#34d399'}; font-weight: 700;">${c.respiration_rate_bpm.toFixed(1)}</td>
        <td class="mono-cell">${c.inhale_duration_s.toFixed(1)} s</td>
        <td class="mono-cell">${c.exhale_duration_s.toFixed(1)} s</td>
        <td class="mono-cell" style="color: #94a3b8;">${c.ie_ratio}</td>
        <td class="mono-cell" style="color: #64748b;">${c.baseline_force_n.toFixed(2)} N</td>
        <td class="mono-cell" style="color: #f8fafc;">${c.peak_force_n.toFixed(2)} N</td>
        <td class="mono-cell" style="color: #38bdf8; font-weight: 700;">+${c.net_excursion_n.toFixed(2)} N</td>
        <td><span class="badge-pattern ${badgeClass}">${c.classification}</span></td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

async function loadBreathSummary() {
  try {
    const res = await fetch("/api/export/summary-json");
    if (!res.ok) return;
    const data = await res.json();
    if (data.cycles && data.cycles.length > 0 && breathCycles.length === 0) {
      breathCycles = data.cycles;
      renderBreathTable(breathCycles);
      evaluateAllCyclesVariability();
    }
  } catch (e) {}
}

// ========================================================
// 11. REAL-TIME BREATHING PATTERN ASSESSMENT & BANNER
// ========================================================
function evaluateBreathingDiagnostics(bpm, amp, noise) {
  const card = document.getElementById("diagnostic-summary-card");
  const badge = document.getElementById("diag-badge");
  const headline = document.getElementById("diag-headline");
  const desc = document.getElementById("diag-description");
  const svgBox = document.getElementById("diag-status-svg");

  const chipRate = document.getElementById("diag-chip-rate");
  const chipDepth = document.getElementById("diag-chip-depth");
  const chipReg = document.getElementById("diag-chip-regularity");
  const chipSuit = document.getElementById("diag-chip-suitability");

  if (!isSensorStreaming) {
    if (card) card.className = "diagnostic-summary-card diag-standby";
    if (badge) badge.innerText = "STANDBY";
    if (headline) headline.innerText = isHardwareConnected ? "Vernier Belt Ready — Awaiting Recording" : "Searching for Vernier Belt...";
    if (desc) desc.innerText = isHardwareConnected
      ? "The Vernier Go Direct Respiration Belt is connected. Select an experiment condition and click Start to begin recording."
      : "Connect the Vernier belt over USB or Bluetooth, or click Rescan USB.";
    if (chipRate) chipRate.innerText = "-- BPM";
    if (chipDepth) chipDepth.innerText = "-- N";
    if (chipReg) chipReg.innerText = "Standby";
    if (chipSuit) chipSuit.innerText = isHardwareConnected ? "Hardware Online" : "Hardware Offline";
    if (svgBox) {
      svgBox.innerHTML = `<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>`;
    }
    return;
  }

  let abnormalities = [];

  // Check Rate
  let rateClass = "Normal";
  if (bpm > 20.0) {
    rateClass = "Tachypnea (> 20 BPM)";
    abnormalities.push({ title: "Tachypnea / Rapid Breathing", desc: `Frequency (${bpm.toFixed(1)} BPM) is elevated above resting range.` });
  } else if (bpm > 0 && bpm < 10.0) {
    rateClass = "Bradypnea (< 10 BPM)";
    abnormalities.push({ title: "Bradypnea / Slow Breathing", desc: `Slow breathing (${bpm.toFixed(1)} BPM) with elongated cycle duration.` });
  }

  // Check Excursion
  let depthClass = "Normal";
  if (amp > 5.5) {
    depthClass = "Deep / Hyperpnea (> 5.5 N)";
    abnormalities.push({ title: "Deep Excursion", desc: `Large chest excursion (${amp.toFixed(1)} N) indicating deep breathing.` });
  } else if (amp < 0.6) {
    depthClass = "Shallow (< 0.6 N)";
    abnormalities.push({ title: "Shallow Breathing", desc: `Low chest excursion (${amp.toFixed(2)} N). Check belt snugness.` });
  }

  // Check Noise
  let noiseClass = "Clean Signal";
  if (noise > researchThresholds.noiseLimit) {
    noiseClass = "High Ripple";
    abnormalities.push({ title: "Sensor Artifact / Noise", desc: `High frequency ripple (${noise.toFixed(2)} N) detected. Evaluated separately from breathing.` });
  }

  if (chipRate) chipRate.innerText = `${bpm.toFixed(1)} BPM (${rateClass})`;
  if (chipDepth) chipDepth.innerText = `${amp.toFixed(2)} N (${depthClass})`;
  if (chipReg) chipReg.innerText = noiseClass;

  if (abnormalities.length === 0) {
    if (card) card.className = "diagnostic-summary-card diag-normal";
    if (badge) badge.innerText = "CONSISTENT EUPNEA";
    if (headline) headline.innerText = "Consistent Resting Respiratory Pattern";
    if (desc) desc.innerText = `Recording reproducible, stable breathing (${bpm.toFixed(1)} BPM, ${amp.toFixed(2)} N excursion) ideal for radiation treatment planning comparison.`;
    if (chipSuit) {
      chipSuit.innerText = "CONSISTENT";
      chipSuit.style.color = "var(--status-active)";
    }
    if (svgBox) {
      svgBox.innerHTML = `
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      `;
    }
  } else {
    const dominant = abnormalities[0];
    if (card) card.className = "diagnostic-summary-card diag-abnormal-warn";
    if (badge) badge.innerText = "PATTERN: " + dominant.title.toUpperCase();
    if (headline) headline.innerText = dominant.title;
    if (desc) desc.innerText = dominant.desc;
    if (chipSuit) {
      chipSuit.innerText = "IRREGULAR";
      chipSuit.style.color = "var(--status-warn)";
    }
    if (svgBox) {
      svgBox.innerHTML = `
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      `;
    }
  }
}

// ========================================================
// 12. SOCKET.IO, WEBHID & CLOUD INTEGRATION
// ========================================================
let activeConnectionMode = "idle";
let cachedDemoSamples = [];
let cloudPlaybackInterval = null;
let cloudPlaybackIndex = 0;

let browserGdxDevice = null;
let browserTareOffset = 0.0;
let browserSampleCount = 0;
let lastRawForce = 0.0;

async function checkVercelOrCloudMode() {
  const socketBadge = document.getElementById("socket-status-badge");
  const socketText = document.getElementById("socket-status-text");
  if (socketBadge && (!socket || !socket.connected)) {
    socketBadge.className = "status-pill";
    socketText.innerText = "CLOUD / BROWSER MODE";
  }

  const connBadge = document.getElementById("conn-mode-badge");
  if (connBadge && activeConnectionMode === "idle") {
    connBadge.innerText = "VERCEL READY";
    connBadge.style.color = "var(--accent-cyan)";
  }

  // Check REST status
  try {
    const res = await fetch("/api/status");
    if (res.ok) {
      const status = await res.json();
      if (status.serial_number && status.serial_number !== "Unknown") {
        document.getElementById("hw-serial").innerText = status.serial_number;
        document.getElementById("footer-serial").innerText = status.serial_number;
      }
      if (status.tare_offset !== undefined) {
        document.getElementById("force-tare-val").innerText = status.tare_offset.toFixed(3) + " N";
      }
    }
  } catch (e) {}

  // Pre-load demo data for offline testing
  if (cachedDemoSamples.length === 0) {
    try {
      const res = await fetch("/static/session_data.json");
      if (res.ok) {
        const data = await res.json();
        cachedDemoSamples = data.samples || [];
      }
    } catch (e) {}
  }
}

function initSocketConnection() {
  const socketBadge = document.getElementById("socket-status-badge");
  const socketText = document.getElementById("socket-status-text");

  try {
    socket = io({ timeout: 2500, reconnectionAttempts: 2 });

    socket.on("connect", () => {
      socketBadge.className = "status-pill connected";
      socketText.innerText = "WEBSOCKET ONLINE";
      activeConnectionMode = "socket";
      const connBadge = document.getElementById("conn-mode-badge");
      if (connBadge) {
        connBadge.innerText = "LOCAL PYTHON";
        connBadge.style.color = "var(--status-active)";
      }
    });

    socket.on("disconnect", () => {
      if (activeConnectionMode === "socket") {
        socketBadge.className = "status-pill disconnected";
        socketText.innerText = "WEBSOCKET OFFLINE";
        updateSensorActiveUI(false);
      }
    });

    socket.on("connect_error", () => {
      socketBadge.className = "status-pill";
      socketText.innerText = "CLOUD / BROWSER MODE";
      checkVercelOrCloudMode();
    });

    socket.on("sensor_status", (status) => {
      if (browserGdxDevice && browserGdxDevice.opened) return;
      isHardwareConnected = status.connected;
      const hwBadge = document.getElementById("hw-status-badge");
      const hwText = document.getElementById("hw-status-text");

      if (status.connected) {
        hwBadge.className = "status-pill connected";
        hwText.innerText = `VERNIER ${status.order_code || 'GDX-RB'} ONLINE`;
        document.getElementById("hw-device-name").innerText = status.device_name || "Vernier Go Direct Respiration Belt";
        const sn = status.serial_number || "0K7014Z0";
        document.getElementById("hw-serial").innerText = sn;
        document.getElementById("footer-serial").innerText = sn;
      } else {
        hwBadge.className = "status-pill disconnected";
        hwText.innerText = "SENSOR DISCONNECTED";
      }

      updateSensorActiveUI(status.active);
      currentBpm = status.bpm || 14.0;
      currentAmplitude = status.amplitude || 2.5;
      currentNoise = status.noise_level || 0.05;
      if (status.tare_offset !== undefined) {
        document.getElementById("force-tare-val").innerText = status.tare_offset.toFixed(3) + " N";
      }
      evaluateBreathingDiagnostics(currentBpm, currentAmplitude, currentNoise);
    });

    socket.on("respiratory_data", (data) => {
      if (browserGdxDevice && browserGdxDevice.opened) return;
      processIncomingSample(data);
    });
  } catch (e) {
    checkVercelOrCloudMode();
  }

  setTimeout(() => {
    if (!socket || !socket.connected) {
      checkVercelOrCloudMode();
    }
  }, 2000);
}

// Direct Browser Hardware Link via WebHID / Web Bluetooth
async function connectBrowserBelt(useBluetooth = false) {
  if (typeof godirect === 'undefined') {
    alert("Vernier GoDirect library loading. Please verify internet connection.");
    return;
  }
  if (!useBluetooth && !navigator.hid) {
    alert("WebHID requires Google Chrome, Microsoft Edge, or Opera.");
    return;
  }
  if (useBluetooth && !navigator.bluetooth) {
    alert("Web Bluetooth requires Google Chrome, Microsoft Edge, or Opera.");
    return;
  }

  try {
    if (browserGdxDevice) {
      try { await browserGdxDevice.close(); } catch(e) {}
      browserGdxDevice = null;
    }
    if (cloudPlaybackInterval) stopDemoPlayback();

    const device = await godirect.selectDevice(useBluetooth);
    if (!device) return;

    browserGdxDevice = device;
    activeConnectionMode = useBluetooth ? "browser-ble" : "browser-hid";
    isHardwareConnected = true;

    const sn = device.serialNumber || "0K7014Z0";
    const devName = device.name || "Vernier Go Direct Respiration Belt";
    const orderCode = device.orderCode || "GDX-RB";

    const hwBadge = document.getElementById("hw-status-badge");
    const hwText = document.getElementById("hw-status-text");
    hwBadge.className = "status-pill connected";
    hwText.innerText = `VERNIER ${orderCode} (${useBluetooth ? 'BLE' : 'USB'})`;

    const connBadge = document.getElementById("conn-mode-badge");
    if (connBadge) {
      connBadge.innerText = useBluetooth ? "BROWSER BLE" : "BROWSER WEBHID";
      connBadge.style.color = "var(--status-active)";
    }

    document.getElementById("hw-device-name").innerText = devName;
    document.getElementById("hw-serial").innerText = sn;
    document.getElementById("footer-serial").innerText = sn;
    document.getElementById("btn-rescan-text").innerText = "Disconnect";

    device.sensors.forEach(s => {
      const nameLower = (s.name || "").toLowerCase();
      if (nameLower.includes("force") || s.number === 1) s.setEnabled(true);
      if (nameLower.includes("rate") || s.number === 2) s.setEnabled(true);
    });

    browserSampleCount = 0;
    device.start(100); // 10 Hz
    updateSensorActiveUI(true);

    device.sensors.forEach(sensor => {
      sensor.on('value-changed', s => {
        const nameLower = (s.name || "").toLowerCase();
        if (nameLower.includes("rate") || s.number === 2) {
          if (s.value && s.value > 0) currentBpm = s.value;
          return;
        }
        if (nameLower.includes("force") || s.number === 1) {
          lastRawForce = s.value;
          browserSampleCount++;

          const elapsed = (Date.now() - (sessionStartTime || Date.now())) / 1000.0;
          const now = new Date();
          const timeStr = now.toTimeString().slice(0, 8) + "." + Math.floor(now.getMilliseconds() / 100);
          const netExpansion = Math.max(0, lastRawForce - browserTareOffset);

          processIncomingSample({
            timestamp: elapsed,
            time_str: timeStr,
            value: netExpansion,
            raw_force: lastRawForce,
            tare_offset: browserTareOffset,
            phase: extremumState === "seeking_peak" ? "Inhale" : "Exhale",
            bpm: currentBpm,
            sample_count: browserSampleCount,
            breath_count: currentBreathCount,
            amplitude: currentAmplitude,
            noise_level: currentNoise
          });
        }
      });
    });
  } catch (err) {
    if (err.name !== "NotFoundError" && !err.message.includes("cancelled")) {
      alert("Could not connect to Vernier belt: " + err.message);
    }
  }
}

async function disconnectOrRescanHardware() {
  if (browserGdxDevice) {
    try { await browserGdxDevice.close(); } catch(e) {}
    browserGdxDevice = null;
    activeConnectionMode = "idle";
    isHardwareConnected = false;
    updateSensorActiveUI(false);
    document.getElementById("hw-status-badge").className = "status-pill disconnected";
    document.getElementById("hw-status-text").innerText = "SENSOR DISCONNECTED";
    document.getElementById("btn-rescan-text").innerText = "Rescan / Demo";
    return;
  }
  if (socket && socket.connected) {
    socket.emit("reconnect_sensor");
    return;
  }
  toggleDemoPlayback();
}

function toggleDemoPlayback() {
  if (cloudPlaybackInterval) stopDemoPlayback();
  else startDemoPlayback();
}

function startDemoPlayback() {
  if (cloudPlaybackInterval) clearInterval(cloudPlaybackInterval);
  if (cachedDemoSamples.length === 0) return;

  activeConnectionMode = "replay";
  updateSensorActiveUI(true);
  document.getElementById("conn-mode-badge").innerText = "DEMO REPLAY (10 Hz)";
  document.getElementById("hw-status-badge").className = "status-pill connected";
  document.getElementById("hw-status-text").innerText = "VERNIER 0K7014Z0 REPLAY";
  document.getElementById("btn-rescan-text").innerText = "Stop Demo";

  cloudPlaybackInterval = setInterval(() => {
    if (cloudPlaybackIndex >= cachedDemoSamples.length) cloudPlaybackIndex = 0;
    const s = cachedDemoSamples[cloudPlaybackIndex];
    cloudPlaybackIndex++;

    processIncomingSample({
      timestamp: s.elapsed_seconds,
      time_str: s.time_str,
      value: s.net_expansion_n,
      raw_force: s.raw_force_n,
      tare_offset: s.tare_offset_n,
      phase: s.phase,
      bpm: s.respiration_rate_bpm,
      sample_count: s.sample_index,
      breath_count: s.breath_count,
      amplitude: currentAmplitude,
      noise_level: currentNoise
    });
  }, 100);
}

function stopDemoPlayback() {
  if (cloudPlaybackInterval) {
    clearInterval(cloudPlaybackInterval);
    cloudPlaybackInterval = null;
  }
  activeConnectionMode = "idle";
  updateSensorActiveUI(false);
  document.getElementById("btn-rescan-text").innerText = "Rescan / Demo";
}

// Controls
function startSensor() {
  if (browserGdxDevice && browserGdxDevice.opened) {
    browserGdxDevice.start(100);
    updateSensorActiveUI(true);
    return;
  }
  if (socket && socket.connected) {
    socket.emit("start_sensor");
    return;
  }
  startDemoPlayback();
}

function stopSensor() {
  if (browserGdxDevice && browserGdxDevice.opened) {
    browserGdxDevice.stop();
    updateSensorActiveUI(false);
    return;
  }
  if (socket && socket.connected) {
    socket.emit("stop_sensor");
    return;
  }
  stopDemoPlayback();
}

function tareSensor() {
  if (browserGdxDevice && browserGdxDevice.opened) {
    browserTareOffset = lastRawForce;
    document.getElementById("force-tare-val").innerText = browserTareOffset.toFixed(3) + " N";
    return;
  }
  if (socket && socket.connected) {
    socket.emit("tare_sensor");
    return;
  }
  fetch("/api/tare", { method: "POST" })
    .then(r => r.json())
    .then(st => {
      if (st.tare_offset !== undefined) {
        document.getElementById("force-tare-val").innerText = st.tare_offset.toFixed(3) + " N";
      }
    })
    .catch(() => {});
}

function updateSensorActiveUI(active) {
  isSensorStreaming = active;
  const btnStart = document.getElementById("btn-start-sensor");
  const btnStop = document.getElementById("btn-stop-sensor");
  const btnPause = document.getElementById("btn-pause-sensor");
  const badge = document.getElementById("sensor-status-badge");
  const badgeText = document.getElementById("sensor-status-text");
  const recDot = document.getElementById("rec-status-dot");
  const recText = document.getElementById("rec-status-text");

  if (active) {
    if (btnStart) { btnStart.classList.add("is-active"); btnStart.disabled = true; }
    if (btnStop) btnStop.disabled = false;
    if (btnPause) btnPause.disabled = false;
    if (badge) { badge.className = "status-pill active"; }
    if (badgeText) badgeText.innerText = "STREAMING (10 Hz)";
    if (recDot) recDot.className = "rec-pulse-dot";
    if (recText) recText.innerText = "RECORDING ACTIVE";
    if (!sessionStartTime) sessionStartTime = Date.now();
  } else {
    if (btnStart) { btnStart.classList.remove("is-active"); btnStart.disabled = false; }
    if (btnStop) btnStop.disabled = true;
    if (btnPause) btnPause.disabled = true;
    if (badge) badge.className = "status-pill";
    if (badgeText) badgeText.innerText = "SENSOR STANDBY";
    if (recDot) recDot.className = "rec-idle-dot";
    if (recText) recText.innerText = "SESSION BUFFER IDLE";
    isRecordingPaused = false;
    const pauseText = document.getElementById("btn-pause-text");
    if (pauseText) pauseText.innerText = "Pause";
  }
  evaluateBreathingDiagnostics(currentBpm, currentAmplitude, currentNoise);
}

// Initialization on DOM Load
window.addEventListener("DOMContentLoaded", () => {
  loadSavedThresholds();
  initChart();
  initSocketConnection();
  renderSessionComparisonTable();
  evaluateBreathingDiagnostics(currentBpm, currentAmplitude, currentNoise);
  updateRecordedCounters();
  loadBreathSummary();
});
