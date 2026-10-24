"""
RESPITRACK // Vernier Go Direct® Respiration Belt Acquisition & Recording System
Physical Belt Sensor Backend (Vernier Go Direct® Respiration Belt GDX-RB)
Backend: Flask & Flask-SocketIO with godirect USB HID interface
Continuous Breathing Pattern Acquisition, Real-Time Analysis & CSV/JSON Data Export
"""

import os
import io
import csv
import time
import math
import threading
from datetime import datetime, timezone
from collections import deque
from flask import Flask, render_template, jsonify, Response, request
from flask_socketio import SocketIO, emit
from godirect import GoDirect

app = Flask(__name__)
app.config['SECRET_KEY'] = 'respitrack_belt_sensor_key_2026'

# Threading mode is robust across all modern Python versions (3.10-3.14+)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


class PhysicalBeltSensor:
    """
    Manages connection, 10 Hz physical streaming, and continuous session data
    recording from the Vernier Go Direct Respiration Belt (GDX-RB) over USB HID.
    Specialized purely for physiological breathing pattern collection.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.godirect = None
        self.device = None
        self.is_connected = False
        self.is_streaming = False
        self.stop_event = threading.Event()
        self.worker_thread = None

        # Device Metadata
        self.device_name = "Vernier Go Direct Respiration Belt"
        self.order_code = "GDX-RB"
        self.serial_number = "Unknown"

        # Calibration & Telemetry
        self.tare_offset = 0.0          # Subtracted from raw force (in Newtons)
        self.last_force = 0.0
        self.sample_count = 0
        self.breath_count = 0           # Count of completed breath cycles
        self.start_timestamp = None
        self.current_bpm = 14.0
        self.current_amplitude = 2.5    # Rolling peak-to-trough in N
        self.current_noise = 0.05       # Rolling noise standard deviation in N
        self.last_phase = "Standby"

        # Continuous Session Data Logging
        self.session_records = []

        # Rolling buffer for physiological metrics (15-second window at 10 Hz = 150 samples)
        self.history_force = deque(maxlen=150)
        self.history_timestamps = deque(maxlen=150)
        self.recent_peak_times = deque(maxlen=10)

        # Initialize hardware connection
        self.connect_hardware()

    def connect_hardware(self):
        """Attempts to find and open the physical Vernier Go Direct sensor over USB."""
        with self._lock:
            try:
                if self.device:
                    try:
                        self.device.stop()
                        self.device.close()
                    except Exception:
                        pass
                    self.device = None

                if self.godirect:
                    try:
                        self.godirect.quit()
                    except Exception:
                        pass
                    self.godirect = None

                # Initialize GoDirect USB engine
                self.godirect = GoDirect(use_ble=False, use_usb=True)
                self.device = self.godirect.get_device(threshold=-100)

                if self.device and self.device.open():
                    self.device_name = getattr(self.device, "description", "Vernier Go Direct Respiration Belt")
                    self.order_code = getattr(self.device, "order_code", "GDX-RB")
                    self.serial_number = getattr(self.device, "serial_number", "Unknown")
                    self.is_connected = True

                    # Channel 1: Force (N), Channel 2: Respiration Rate (bpm)
                    self.device.enable_sensors([1, 2])
                    print(f"[Vernier Hardware] Connected to {self.device_name} (S/N: {self.serial_number})")
                    return True
                else:
                    self.is_connected = False
                    print("[Vernier Hardware] No USB Go Direct sensor detected.")
                    return False
            except Exception as e:
                self.is_connected = False
                print(f"[Vernier Hardware] Connection error: {e}")
                return False

    def get_status(self):
        with self._lock:
            return {
                "connected": self.is_connected,
                "active": self.is_streaming,
                "device_name": self.device_name,
                "order_code": self.order_code,
                "serial_number": self.serial_number,
                "tare_offset": round(self.tare_offset, 3),
                "bpm": round(self.current_bpm, 1),
                "amplitude": round(self.current_amplitude, 2),
                "noise_level": round(self.current_noise, 3),
                "sample_count": self.sample_count,
                "breath_count": self.breath_count,
                "recorded_count": len(self.session_records),
                "frequency_hz": 10.0,
                "phase": self.last_phase
            }

    def tare(self):
        """Zeroes the resting baseline to the most recent raw force measurement."""
        with self._lock:
            self.tare_offset = self.last_force
            print(f"[Vernier Hardware] Tared baseline to {self.tare_offset:.3f} N")
            return self.tare_offset

    def get_session_records(self):
        """Returns a snapshot copy of all recorded session samples."""
        with self._lock:
            return list(self.session_records)

    def clear_session_records(self):
        """Clears accumulated session samples and breath counter."""
        with self._lock:
            self.session_records = []
            self.sample_count = 0
            self.breath_count = 0
            print("[Vernier Hardware] Cleared session recording buffer.")

    def start(self):
        """Starts 10 Hz physical data streaming and session recording."""
        with self._lock:
            if not self.is_connected or not self.device:
                if not self.connect_hardware():
                    return False

            if self.is_streaming:
                return True

            try:
                # 100 ms period = 10 Hz
                self.device.start(period=100)
                self.is_streaming = True
                self.stop_event.clear()
                self.start_timestamp = time.time()
                self.history_force.clear()
                self.history_timestamps.clear()
                self.recent_peak_times.clear()

                self.worker_thread = threading.Thread(target=self._read_loop, daemon=True)
                self.worker_thread.start()
                return True
            except Exception as e:
                print(f"[Vernier Hardware] Start failed: {e}")
                self.is_streaming = False
                return False

    def stop(self):
        """Stops physical data streaming."""
        with self._lock:
            if not self.is_streaming:
                return True
            self.is_streaming = False
            self.stop_event.set()

            if self.device:
                try:
                    self.device.stop()
                except Exception:
                    pass

        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=1.0)
        return True

    def _calculate_instant_bpm(self, now, net_expansion):
        """
        Calculates respiration rate (BPM) from rolling peak detection and
        increments completed breath cycles.
        """
        self.history_force.append(net_expansion)
        self.history_timestamps.append(now)

        if len(self.history_force) < 25:  # Need at least 2.5 seconds of data
            return self.current_bpm

        forces = list(self.history_force)
        times = list(self.history_timestamps)

        min_f = min(forces)
        max_f = max(forces)
        amp = max_f - min_f
        self.current_amplitude = amp

        # High-frequency tremor / noise estimation
        if len(forces) >= 10:
            diffs = [abs(forces[i] - forces[i-1]) for i in range(1, len(forces))]
            self.current_noise = sum(diffs) / len(diffs)

        if amp > 0.35 and len(forces) >= 5:
            # Check if previous point is a peak
            if forces[-2] > forces[-1] and forces[-2] > forces[-3] and forces[-2] > (min_f + 0.55 * amp):
                peak_time = times[-2]
                if not self.recent_peak_times or (peak_time - self.recent_peak_times[-1]) > 1.2:
                    self.recent_peak_times.append(peak_time)
                    self.breath_count += 1
                    if len(self.recent_peak_times) >= 2:
                        intervals = [
                            self.recent_peak_times[i] - self.recent_peak_times[i - 1]
                            for i in range(1, len(self.recent_peak_times))
                        ]
                        mean_interval = sum(intervals) / len(intervals)
                        if 1.5 <= mean_interval <= 15.0:
                            calc_bpm = 60.0 / mean_interval
                            self.current_bpm = round(0.7 * self.current_bpm + 0.3 * calc_bpm, 1)

        return self.current_bpm

    def _read_loop(self):
        """10 Hz background physical reading loop."""
        interval = 0.1  # 100 ms = 10 Hz
        t_start = time.time()
        next_tick = t_start + interval

        while not self.stop_event.is_set():
            t_now = time.time()
            elapsed = t_now - t_start

            raw_force = 0.0
            device_bpm = None

            try:
                if self.device and self.device.read():
                    sensors = self.device.get_enabled_sensors()
                    if len(sensors) > 0 and sensors[0].value is not None:
                        raw_force = float(sensors[0].value)
                    if len(sensors) > 1 and sensors[1].value is not None:
                        val = sensors[1].value
                        if not math.isnan(val) and val > 0:
                            device_bpm = float(val)
                else:
                    time.sleep(0.02)
                    continue
            except Exception as e:
                print(f"[Vernier Hardware] Read error: {e}")
                self.is_connected = False
                break

            with self._lock:
                self.last_force = raw_force
                self.sample_count += 1
                count = self.sample_count
                tare_val = self.tare_offset

            # Net chest expansion force (clamped to non-negative tension)
            net_expansion = max(0.0, raw_force - tare_val)

            # Respiration Rate: Use on-board sensor BPM if available; otherwise rolling peak detector
            if device_bpm is not None and 4.0 <= device_bpm <= 50.0:
                self.current_bpm = round(device_bpm, 1)
                self._calculate_instant_bpm(t_now, net_expansion)
            else:
                self._calculate_instant_bpm(t_now, net_expansion)

            # Determine real-time respiratory phase from breathing kinetics
            derivative = net_expansion - (self.history_force[-2] if len(self.history_force) >= 2 else net_expansion)
            amp = max(0.5, self.current_amplitude)

            if net_expansion >= (0.80 * amp):
                phase_label = "End-Inspiration (Peak)"
            elif net_expansion <= (0.20 * amp):
                phase_label = "End-Expiration (Trough)"
            elif derivative > 0.03:
                phase_label = "Inhaling (Expansion)"
            elif derivative < -0.03:
                phase_label = "Exhaling (Contraction)"
            else:
                phase_label = "Plateau"

            self.last_phase = phase_label

            # Format timestamps
            time_str = time.strftime("%H:%M:%S", time.localtime(t_now)) + f".{int((t_now % 1) * 10)}"
            now_iso = datetime.now(timezone.utc).isoformat()

            # Record sample in continuous session log (up to 200,000 samples = ~5.5 hours)
            record = {
                "sample_index": count,
                "timestamp_iso": now_iso,
                "time_str": time_str,
                "elapsed_seconds": round(elapsed, 2),
                "raw_force_n": round(raw_force, 4),
                "tare_offset_n": round(tare_val, 4),
                "net_expansion_n": round(net_expansion, 4),
                "respiration_rate_bpm": self.current_bpm,
                "phase": phase_label,
                "breath_count": self.breath_count
            }

            with self._lock:
                if len(self.session_records) < 200000:
                    self.session_records.append(record)
                total_recorded = len(self.session_records)
                current_breaths = self.breath_count

            payload = {
                "timestamp": round(elapsed, 2),
                "time_str": time_str,
                "value": round(net_expansion, 2),        # Calibrated expansion in Newtons (N)
                "raw_force": round(raw_force, 3),        # Raw un-tared Force in N
                "tare_offset": round(tare_val, 3),
                "phase": phase_label,
                "bpm": self.current_bpm,
                "sample_count": count,
                "breath_count": current_breaths,
                "recorded_count": total_recorded,
                "amplitude": round(self.current_amplitude, 2),
                "noise_level": round(self.current_noise, 3),
                "unit": "N"
            }

            # Broadcast over WebSocket to all connected web clients
            socketio.emit("respiratory_data", payload)

            # Precision pacing for 10 Hz
            sleep_duration = next_tick - time.time()
            if sleep_duration > 0:
                self.stop_event.wait(timeout=sleep_duration)
            next_tick += interval
            if next_tick < time.time():
                next_tick = time.time() + interval

        # Cleanup if thread exits due to device disconnect
        with self._lock:
            self.is_streaming = False
        socketio.emit("sensor_status", self.get_status())


# Initialize singleton sensor manager
sensor = PhysicalBeltSensor()


@app.route("/")
def index():
    """Renders the Respiration Belt Breathing Pattern Acquisition Console."""
    return render_template("index.html")


@app.route("/api/status")
def get_status():
    """REST status endpoint for hardware verification."""
    return jsonify(sensor.get_status())


@app.route("/api/tare", methods=["POST"])
def post_tare():
    """Zeroes the resting baseline to the current physical sensor reading."""
    new_offset = sensor.tare()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)
    return jsonify({"success": True, "tare_offset": new_offset, "status": status})


@app.route("/api/reconnect", methods=["POST"])
def post_reconnect():
    """Rescans USB and reconnects to the Vernier Go Direct Respiration Belt."""
    success = sensor.connect_hardware()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)
    return jsonify({"success": success, "status": status})


# ==========================================
# Breathing Pattern Data Export Endpoints
# ==========================================

@app.route("/api/export/csv")
def export_csv():
    """
    Exports the collected breathing pattern session as a standardized CSV file,
    including device serial number, calibration offsets, timestamps, and respiratory kinetics.
    """
    records = sensor.get_session_records()
    now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    serial = sensor.serial_number or "0K7014Z0"
    filename = f"breathing_pattern_{serial}_{now_str}.csv"

    output = io.StringIO()
    output.write("# RESPITRACK // Vernier Go Direct® Respiration Belt Breathing Pattern Export\n")
    output.write(f"# Device: {sensor.device_name}\n")
    output.write(f"# Model: {sensor.order_code} | Serial Number: {serial}\n")
    output.write(f"# Export Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    output.write(f"# Sampling Frequency: 10.0 Hz (100 ms interval)\n")
    output.write(f"# Total Samples: {len(records)}\n")
    output.write(f"# Total Breaths Logged: {sensor.breath_count}\n")
    output.write(f"# Duration: {len(records) * 0.1:.1f} seconds\n")
    output.write("# Calibration: Net Expansion Force (N) = max(0, Raw Force - Tare Offset)\n")
    output.write("#\n")

    fieldnames = [
        "sample_index",
        "timestamp_iso",
        "time_str",
        "elapsed_seconds",
        "raw_force_n",
        "tare_offset_n",
        "net_expansion_n",
        "respiration_rate_bpm",
        "phase",
        "breath_count"
    ]

    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in records:
        writer.writerow(row)

    csv_data = output.getvalue()
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename={filename}",
            "Content-Type": "text/csv; charset=utf-8"
        }
    )


@app.route("/api/export/json")
def export_json():
    """Exports the collected breathing pattern session as structured JSON."""
    records = sensor.get_session_records()
    now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    serial = sensor.serial_number or "0K7014Z0"
    filename = f"breathing_pattern_{serial}_{now_str}.json"

    payload = {
        "system": "RESPITRACK",
        "device_name": sensor.device_name,
        "order_code": sensor.order_code,
        "serial_number": serial,
        "export_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "sampling_frequency_hz": 10.0,
        "total_samples": len(records),
        "total_breaths_logged": sensor.breath_count,
        "duration_seconds": round(len(records) * 0.1, 1),
        "samples": records
    }

    return Response(
        jsonify(payload).get_data(as_text=True),
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@app.route("/api/export/clear", methods=["POST"])
def post_clear_export():
    """Clears the session recording buffer."""
    sensor.clear_session_records()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)
    return jsonify({"success": True, "status": status})


# ==========================================
# Socket.IO Event Handlers
# ==========================================

@socketio.on("connect")
def handle_connect():
    """Handle new client connection and send current hardware status."""
    emit("sensor_status", sensor.get_status())


@socketio.on("start_sensor")
def handle_start_sensor():
    """Start the 10 Hz physical sensor data stream and session recording."""
    started = sensor.start()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)


@socketio.on("stop_sensor")
def handle_stop_sensor():
    """Stop the physical sensor data stream."""
    stopped = sensor.stop()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)


@socketio.on("tare_sensor")
def handle_tare_sensor():
    """Zeroes the resting baseline force."""
    offset = sensor.tare()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)


@socketio.on("reconnect_sensor")
def handle_reconnect_sensor():
    """Rescans USB bus and re-establishes connection."""
    sensor.connect_hardware()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)


@socketio.on("clear_recording")
def handle_clear_recording():
    """Clears the session recording history."""
    sensor.clear_session_records()
    status = sensor.get_status()
    socketio.emit("sensor_status", status)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"\n=======================================================")
    print(f" RespiTrack // Vernier Respiration Belt Recorder")
    print(f" Physical Sensor: {sensor.device_name} (S/N: {sensor.serial_number})")
    print(f" Connected via USB: {sensor.is_connected}")
    print(f" Running locally on: http://127.0.0.1:{port}")
    print(f" Data Export: CSV (/api/export/csv) & JSON (/api/export/json)")
    print(f"=======================================================\n")
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
