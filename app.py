"""
Virtual Belt Sensor Simulator & Radiation Oncology Gating Monitoring System
Backend: Flask & Flask-SocketIO
"""

import time
import math
import random
import threading
from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config['SECRET_KEY'] = 'radiation_oncology_gating_secret_key_2026'

# Initialize SocketIO with threading mode (compatible with Python 3.10-3.14+)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


class BeltSensorSimulator:
    """
    Simulates a respiratory belt displacement transducer (e.g. pneumatic or strain-gauge belt)
    broadcasting simulated breathing signals (sinusoidal wave + physiological noise)
    at a continuous 10 Hz frequency (100 ms intervals).
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.is_running = False
        self.stop_event = threading.Event()
        self.worker_thread = None

        # Physiological simulation parameters
        self.bpm = 14.0            # Breaths per minute (typical adult resting: 12-16)
        self.amplitude = 8.0       # Peak-to-valley displacement in mm (chest expansion)
        self.baseline = 2.0        # End-expiration baseline offset in mm
        self.noise_level = 0.25    # Standard deviation of physiological noise in mm
        
        # Telemetry stats
        self.sample_count = 0
        self.start_timestamp = None
        self.last_value = self.baseline

    def get_status(self):
        with self._lock:
            return {
                "active": self.is_running,
                "bpm": self.bpm,
                "amplitude": self.amplitude,
                "baseline": self.baseline,
                "noise_level": self.noise_level,
                "sample_count": self.sample_count,
                "frequency_hz": 10.0
            }

    def update_params(self, bpm=None, amplitude=None, baseline=None, noise_level=None):
        with self._lock:
            if bpm is not None:
                self.bpm = max(5.0, min(40.0, float(bpm)))
            if amplitude is not None:
                self.amplitude = max(1.0, min(25.0, float(amplitude)))
            if baseline is not None:
                self.baseline = max(0.0, min(10.0, float(baseline)))
            if noise_level is not None:
                self.noise_level = max(0.0, min(3.0, float(noise_level)))

    def start(self):
        with self._lock:
            if self.is_running:
                return False
            self.is_running = True
            self.stop_event.clear()
            self.sample_count = 0
            self.start_timestamp = time.time()
            self.worker_thread = threading.Thread(target=self._run_loop, daemon=True)
            self.worker_thread.start()
            return True

    def stop(self):
        with self._lock:
            if not self.is_running:
                return False
            self.is_running = False
            self.stop_event.set()
        
        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=1.0)
        return True

    def _run_loop(self):
        """10 Hz background broadcast loop (100 ms per sample)."""
        interval = 0.1  # 10 Hz
        t_start = time.time()
        next_tick = t_start + interval

        while not self.stop_event.is_set():
            t_now = time.time()
            elapsed = t_now - t_start

            with self._lock:
                bpm = self.bpm
                amplitude = self.amplitude
                baseline = self.baseline
                noise_level = self.noise_level
                self.sample_count += 1
                count = self.sample_count

            # Physiological respiratory model:
            # Frequency in Hz = bpm / 60
            freq_hz = bpm / 60.0
            phase_rad = 2.0 * math.pi * freq_hz * elapsed

            # Standardized asymmetric respiratory cycle:
            # Patients spend slightly more time at end-expiration than peak inhalation.
            # Using (1 - cos(theta))/2 raised to 1.15 gives a realistic breathing wave.
            normalized_sine = (1.0 - math.cos(phase_rad)) / 2.0
            cycle_val = math.pow(normalized_sine, 1.15)

            # Physiological noise (cardiac ballistocardiogram ripple + thoracic muscle tremor)
            phys_noise = random.gauss(0.0, noise_level) if noise_level > 0 else 0.0
            
            # Simulated displacement signal (in mm)
            raw_displacement = baseline + (amplitude * cycle_val) + phys_noise
            signal_value = max(0.0, raw_displacement)

            # Determine respiratory phase based on waveform derivative
            derivative = signal_value - self.last_value
            self.last_value = signal_value

            if signal_value >= (baseline + 0.85 * amplitude):
                phase_label = "End-Inspiration (Peak)"
            elif signal_value <= (baseline + 0.18 * amplitude):
                phase_label = "End-Expiration (Trough)"
            elif derivative > 0.04:
                phase_label = "Inhaling (Expansion)"
            elif derivative < -0.04:
                phase_label = "Exhaling (Contraction)"
            else:
                phase_label = "Transition"

            # Format current timestamp
            time_str = time.strftime("%H:%M:%S", time.localtime(t_now)) + f".{int((t_now % 1) * 10)}"

            payload = {
                "timestamp": round(elapsed, 2),
                "time_str": time_str,
                "value": round(signal_value, 2),
                "phase": phase_label,
                "bpm": round(bpm, 1),
                "sample_count": count,
                "baseline": baseline,
                "amplitude": amplitude
            }

            # Broadcast over WebSocket to all connected clients
            socketio.emit("respiratory_data", payload)

            # Sleep accurately until next 10 Hz tick
            sleep_duration = next_tick - time.time()
            if sleep_duration > 0:
                self.stop_event.wait(timeout=sleep_duration)
            next_tick += interval
            # Catch up if delayed
            if next_tick < time.time():
                next_tick = time.time() + interval


# Singleton simulator instance
simulator = BeltSensorSimulator()


@app.route("/")
def index():
    """Renders the single unified monitoring and control interface."""
    return render_template("index.html")


@app.route("/api/status")
def get_api_status():
    """REST endpoint fallback for system status inspection."""
    return jsonify(simulator.get_status())


# ==========================================
# Socket.IO Event Handlers
# ==========================================

@socketio.on("connect")
def handle_connect():
    """Handle new client connection and send current state."""
    status = simulator.get_status()
    emit("sensor_status", status)


@socketio.on("start_sensor")
def handle_start_sensor():
    """Start the 10 Hz respiratory data stream."""
    started = simulator.start()
    status = simulator.get_status()
    # Broadcast to all clients
    socketio.emit("sensor_status", status)


@socketio.on("stop_sensor")
def handle_stop_sensor():
    """Stop the respiratory data stream."""
    stopped = simulator.stop()
    status = simulator.get_status()
    # Broadcast to all clients
    socketio.emit("sensor_status", status)


@socketio.on("update_params")
def handle_update_params(data):
    """Update respiratory simulation parameters on the fly."""
    if not isinstance(data, dict):
        return
    simulator.update_params(
        bpm=data.get("bpm"),
        amplitude=data.get("amplitude"),
        baseline=data.get("baseline"),
        noise_level=data.get("noise_level")
    )
    status = simulator.get_status()
    socketio.emit("sensor_status", status)


import os

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"\n=======================================================")
    print(f" Radiation Oncology Respiratory Gating System")
    print(f" Running locally on: http://127.0.0.1:{port}")
    print(f"=======================================================\n")
    socketio.run(app, host="0.0.0.0", port=port, debug=True, allow_unsafe_werkzeug=True)
