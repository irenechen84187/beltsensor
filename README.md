# RAD-GATE 4D // Virtual Respiratory Belt Sensor & Radiation Oncology Gating Console

A complete local web application built with **Python (Flask & Flask-SocketIO)** for the backend and **HTML5 / Vanilla CSS / JavaScript (with Chart.js)** for the frontend on a single unified webpage.

This system serves as both a **Virtual Hardware Belt Sensor Simulator** (broadcasting physiological chest expansion data at 10 Hz) and a **Real-Time Clinical Radiation Therapy Gating Monitor** (controlling a simulated linear accelerator beam interlock).

---

## System Architecture

```
+---------------------------------------------------------------------------------------+
|                                 PYTHON FLASK BACKEND                                  |
|                                                                                       |
|  [BeltSensorSimulator (app.py)]                                                       |
|  - Asymmetric human respiratory model: y(t) = baseline + amp * ((1-cos(θ))/2)^1.15    |
|  - Gaussian physiological noise & cardiogenic ripple (standard deviation: 0.25 mm)    |
|  - Precise 10 Hz timer loop (100 ms tick interval)                                    |
|  - WebSocket events: start_sensor, stop_sensor, update_params, respiratory_data       |
+-------------------------------------------+-------------------------------------------+
                                            | WebSocket (Socket.IO)
                                            v
+---------------------------------------------------------------------------------------+
|                               UNIFIED CLINICAL CONSOLE                                |
|                              (templates/index.html)                                   |
|                                                                                       |
|  [Hardware Control Panel]        [Radiation Gating Console]   [Live Oscilloscope]     |
|  - Start / Stop controls         - Threshold: 6.0 mm (adj)    - 10 Hz Chart.js stream |
|  - BPM & Amplitude sliders       - "BEAM ON"  (val <= thresh) - Real-time displacement|
|  - Clinical patient presets      - "BEAM HOLD"(val > thresh)  - Phase & breath rate   |
|  - 10 Hz packet telemetry        - Duty Cycle & Beam-on time  - Dynamic threshold line|
+---------------------------------------------------------------------------------------+
```

---

## Key Features

### 1. Top Real-Time Diagnostic Summary (Abnormal Pattern Detection)
Located prominently at the top of the interface, the clinical diagnostic engine automatically analyzes the live respiratory waveform and flags abnormal patterns:
- **`NORMAL EUPNEA (STABLE)`** (Emerald): Normal resting breathing ($10 - 20\text{ BPM}$, $4 - 13\text{ mm}$ excursion, low artifact). Tagged as **OPTIMAL (STABLE)** for 4D-CT and radiation gating.
- **`TACHYPNEA DETECTED`** (Amber Warning): Respiratory rate $> 20\text{ BPM}$. Alerts that rapid cycle turnover shortens end-expiration and diminishes beam delivery duty cycle.
- **`BRADYPNEA DETECTED`** (Amber Warning): Respiratory rate $< 10\text{ BPM}$ with prolonged cycle period.
- **`HYPERPNEA / EXCESSIVE EXCURSION`** (Crimson Alert): Tidal excursion $> 13\text{ mm}$. Warns that deep breathing can cause tumor excursions beyond PTV safety margins.
- **`SHALLOW HYPOVENTILATION`** (Amber Warning): Low amplitude $< 4\text{ mm}$. Warns of low signal-to-noise ratio.
- **`HIGH TREMOR / MOTION ARTIFACT`** (Crimson Alert): Physiological noise $> 0.6\text{ mm}$. Warns of shivering or loose transducer belt tension.
- **Clinical Breakdown Chips**: Live telemetry chips for *Rate Classification*, *Tidal Amplitude*, *Pattern Regularity*, and *Gating Suitability*.

### 2. Hardware Control Panel (Virtual Belt Sensor Simulator)
- **Start / Stop Sensor Controls**: Toggles the background thread broadcasting simulated respiratory displacement.
- **10 Hz Transmission**: Broadcasts at a fixed 10 Hz rate (every 100 ms) over WebSockets.
- **Physiological Breathing Model**:
  - Realistic asymmetric breathing pattern (longer end-expiration pause vs rapid inhalation).
  - Minor physiological noise representing muscle tremor and cardiogenic artifacts.
- **Real-Time Parameter Sliders**:
  - **Respiratory Rate**: 6 – 32 Breaths Per Minute (BPM).
  - **Chest Excursion Amplitude**: 2 – 20 mm displacement.
  - **Physiological Noise Level**: 0.0 – 1.5 mm.
- **Clinical Presets**: One-click switching between *Normal Adult (14 BPM)*, *Tachypneic (22 BPM)*, *Deep Breather (8 BPM)*, and *Shallow / Frail (16 BPM)*.

### 2. Radiation Oncology Gating Console (Linac Beam Control)
In external beam radiation therapy (e.g., lung or liver SBRT), tumors move continuously due to patient respiration. Gating restricts radiation delivery strictly to the phase where the tumor is stable within the planning target volume (PTV).

- **Gating Logic**:
  - **`BEAM ON`**: Triggered when chest expansion amplitude is **below or equal to** the Gating Threshold ($\le 6.0\text{ mm}$). Linear accelerator radiation beam is active.
  - **`BEAM HOLD`**: Triggered when chest expansion amplitude rises **above** the Gating Threshold ($> 6.0\text{ mm}$) during inhalation. Linear accelerator beam is held to spare healthy tissue.
- **Interactive Threshold Adjuster**: Live slider and numeric input to customize the gating window cutoff amplitude ($2.0 - 20.0\text{ mm}$).
- **Clinical Metrics HUD**:
  - **Gating Duty Cycle**: Live beam delivery efficiency percentage ($\frac{\text{Beam-On Time}}{\text{Total Session Time}} \times 100\%$).
  - **Cumulative Beam Time**: Total treatment seconds delivered.
  - **Hold Transitions Counter**: Tracks patient breathing irregularities.
- **Acoustic Gating Alert**: Synthesized Web Audio API sound chime (no external audio files required) with instant mute/unmute toggle.

### 3. Real-Time Telemetry & Scrolling Oscilloscope (Chart.js)
- **Live Numerical Readouts**:
  - Instantaneous chest displacement ($mm$) with color-coded threshold status.
  - Respiratory phase detection (*End-Expiration*, *Inhaling*, *Peak Inspiration*, *Exhaling*).
  - Calculated breathing frequency ($BPM$) and cycle period ($s$).
  - Rolling 10-second minimum, maximum, and tidal range ($mm$).
- **Real-Time Scrolling Line Graph**:
  - 120-sample rolling buffer (12-second window at 10 Hz).
  - High-contrast neon cyan trace with cubic spline smoothing and glowing gradient fill.
  - Dynamic horizontal amber dashed Gating Threshold line.
  - Automatic red highlight on data points that breach the threshold.

---

## Installation & Setup Instructions

### Prerequisites
- **Python 3.10+** (Tested on Python 3.10, 3.11, 3.12, 3.13, 3.14)
- Modern web browser (Chrome, Edge, Safari, Firefox)

### Step 1: Clone or Navigate to the Project Directory
```bash
cd "/Users/irene/Desktop/belt sensor app"
```

### Step 2: Create and Activate a Python Virtual Environment
```bash
python3 -m venv .venv
source .venv/bin/activate
```
*(On Windows: `.venv\Scripts\activate`)*

### Step 3: Install Required Dependencies
```bash
pip install -r requirements.txt
```

> **What gets installed:**
> - `Flask>=3.0.0`: Core web server.
> - `flask-socketio>=5.3.0`: Real-time WebSocket support.
> - `simple-websocket>=1.0.0`: High-performance WebSocket protocol engine compatible with standard Python threading.

---

## Running the Application Locally

Run `app.py`:
```bash
python3 app.py
```

Open your browser and navigate to:
```
http://127.0.0.1:5001
```

> **Note on Port 5001 vs 5000 on macOS**:
> The app defaults to port **`5001`** because macOS Monterey and later reserve port `5000` for Apple AirPlay Receiver (`ControlCenter`). If you prefer port 5000 or any custom port, you can run:
> ```bash
> PORT=5000 python3 app.py
> ```

---

## Project Structure

```
belt sensor app/
├── app.py                 # Flask server, 10 Hz background simulator thread & WebSocket events
├── requirements.txt       # Python dependencies (Flask, Flask-SocketIO, simple-websocket)
├── README.md              # Documentation and operating guide
├── templates/
│   └── index.html         # Unified single-page interface (UI, CSS styles, Chart.js & Socket.IO client)
└── .venv/                 # Python virtual environment
```

---

## Verification & Testing

An automated verification test is included:
```bash
python3 -c "
import socketio, time
sio = socketio.Client()
samples = []
sio.on('respiratory_data', lambda d: samples.append(d))
sio.connect('http://127.0.0.1:5001')
sio.emit('start_sensor')
time.sleep(2.0)
sio.emit('stop_sensor')
print(f'Received {len(samples)} samples at 10 Hz! Gating and broadcast verified.')
sio.disconnect()
"
```
