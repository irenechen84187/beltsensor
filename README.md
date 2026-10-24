# RespiTrack // Vernier Go Direct® Respiration Belt Breathing Pattern Recorder

A local web application built with **Python (Flask & Flask-SocketIO)** for the backend and **HTML5 / Vanilla CSS / JavaScript (with Chart.js)** for the frontend.

This system directly interfaces with a **physical Vernier Go Direct® Respiration Belt (GDX-RB)** via USB HID, streaming physiological chest expansion force and respiration rate at **10 Hz** to a dedicated **Real-Time Breathing Pattern Acquisition, Waveform Oscilloscope, and Session Recording Console**.

---

## Hardware Specifications & Architecture

```
+---------------------------------------------------------------------------------------+
|                 PHYSICAL HARDWARE: VERNIER GO DIRECT® RESPIRATION BELT                |
|                                                                                       |
|  - Transducer: Force gauge ribbon & chest expansion strap                             |
|  - Model / Order Code: GDX-RB                                                         |
|  - Interface: USB Human Interface Device (HID) / Bluetooth Low Energy                 |
|  - Physical Channels:                                                                 |
|      * Channel 1: Force (Newtons, N)                                                  |
|      * Channel 2: Respiration Rate (Breaths Per Minute, BPM)                          |
+-------------------------------------------+-------------------------------------------+
                                            | USB HID via python `godirect`
                                            v
+---------------------------------------------------------------------------------------+
|                                 PYTHON FLASK BACKEND                                  |
|                                      (app.py)                                         |
|  - 10 Hz background data polling thread (100 ms tick interval)                        |
|  - Automatic device discovery & USB reconnection engine                               |
|  - Instantaneous Tare / Zero baseline compensation: Net Force = Raw Force - Tare     |
|  - Algorithmic breath cycle detection & real-time respiration phase estimation        |
|  - Session recording buffer (up to 200,000 samples) & CSV/JSON export engine         |
+-------------------------------------------+-------------------------------------------+
                                            | WebSocket (Socket.IO)
                                            v
+---------------------------------------------------------------------------------------+
|                             BREATHING PATTERN CONSOLE                                 |
|                              (templates/index.html)                                   |
|                                                                                       |
|  [Hardware & Tare Calibration]   [Session Data Logger]    [Live Oscilloscope]         |
|  - Start / Stop Stream controls  - Live duration timer    - 10 Hz Chart.js waveform   |
|  - Tare / Zero Baseline button   - Total samples counter  - Real-time Expansion (N)   |
|  - Raw & Net Force telemetry     - Breaths detected count - Inhalation peak markers   |
|  - S/N & Hardware Status badge   - Download CSV & JSON    - Phase & Breathing Rate    |
+---------------------------------------------------------------------------------------+
```

---

## Operating Guide: Recording Your Breathing Pattern

### 1. Fasten the Belt
1. Unclip the elastic strap and wrap the belt around your lower rib cage or upper abdomen.
2. Fasten the clip securely so the belt is snug against your chest at empty lungs (end-expiration), but comfortable for normal breathing.

### 2. Connect via USB
Plug the USB cable from the Go Direct Respiration Belt into any available USB port on your Mac.

### 3. Start the Web App
```bash
cd "/Users/irene/Desktop/belt sensor app"
./.venv/bin/python app.py
```
Open your browser to:
```
http://127.0.0.1:5001
```

### 4. Zero / Tare Calibration
1. Breathe out naturally and pause briefly at end-expiration (the trough of the breath).
2. Click **Tare / Zero Baseline**. This zeroes the resting baseline tension so that:
   - **End-Expiration Baseline**: $\approx 0.0\text{ N}$
   - **Inhalation Chest Expansion**: $> 0.0\text{ N}$ (typically $1.5\text{ N} - 6.0\text{ N}$)

### 5. Record & Download Session Data
1. Click **Start Recording**. The web app will stream live chest expansion force at 10 Hz and automatically record every sample to the session buffer.
2. Breathe normally (or follow your experimental breathing protocol).
3. Watch the real-time **Breathing Pattern Oscilloscope**, instantaneous **Respiration Rate (BPM)**, **Respiratory Phase**, and **Breath Count**.
4. When finished, click **Stop Recording**.
### 6. Public HTTPS Deployment & Remote Access
To view your physical belt streaming live on your phone, iPad, or share with colleagues anywhere:
```bash
./share_live.sh
```
This generates a secure, free public URL (e.g. `https://instant-newly-recorded-owner.trycloudflare.com`) that tunnels directly to your local Vernier USB hardware.

---

## Data Export Formats

### 1. Physical Breath-by-Breath Summary Report (`/api/export/summary-csv`)
*Aggregates every breath cycle into human-readable physiological kinetics:*

| Column | Description |
| :--- | :--- |
| `breath_number` | Sequential breath index (`#1, #2, #3...`) |
| `clock_start`, `clock_peak`, `clock_end` | Wall-clock timestamps (`HH:MM:SS.s`) |
| `elapsed_start_s`, `elapsed_peak_s`, `elapsed_end_s` | Elapsed recording seconds |
| `cycle_duration_s` | Total breath cycle duration ($T$ in seconds) |
| `respiration_rate_bpm` | Instantaneous respiratory rate ($60/T$ in BPM) |
| `inhale_duration_s` ($T_i$) | Inhalation expansion phase duration |
| `exhale_duration_s` ($T_e$) | Exhalation deflation phase duration |
| `ie_ratio` | Inhalation-to-exhalation ratio ($1:x$) |
| `resting_baseline_force_n` | Baseline tension at start of breath ($N$) |
| `peak_force_n` | Maximum chest expansion force reached ($N$) |
| `net_expansion_force_n` | Net tidal chest excursion ($\Delta F = \text{Peak} - \text{Base}$) |
| `physical_classification` | Clinical pattern (e.g. `Normal Tidal Eupnea`, `Deep Sigh`, `Sustained Breath-Hold`) |

### 2. Raw 10 Hz Time-Series Stream (`/api/export/csv`)
*Continuous 100 ms samples for signal processing & DSP analysis:*

| Column | Description |
| :--- | :--- |
| `sample_index` | Sequential sample number (1, 2, 3...) |
| `timestamp_iso` | Precise UTC ISO-8601 timestamp |
| `time_str` | Wall clock time (`HH:MM:SS.s`) |
| `elapsed_seconds` | Elapsed recording time from session start |
| `raw_force_n` | Raw uncalibrated transducer force ($N$) |
| `tare_offset_n` | Subtracted baseline tension ($N$) |
| `net_expansion_n` | Calibrated chest expansion tension ($N$) |
| `respiration_rate_bpm`| Respiration rate in Breaths Per Minute |
| `phase` | Respiratory phase (`Inhaling`, `Peak`, `Exhaling`, `Trough`) |
| `breath_count` | Cumulative count of completed breath cycles |

---

## API Endpoints

- **Live Status**: `GET /api/status`
- **Tare Calibration**: `POST /api/tare`
- **USB Reconnect**: `POST /api/reconnect`
- **Physical Summary CSV**: `GET /api/export/summary-csv`
- **Physical Summary JSON**: `GET /api/export/summary-json`
- **Raw 10 Hz CSV**: `GET /api/export/csv`
- **Raw JSON Stream**: `GET /api/export/json`
- **Clear Session Buffer**: `POST /api/export/clear`

