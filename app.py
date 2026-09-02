
import cv2

import numpy as np

import base64

import time

from flask import Flask, render_template, request, jsonify

from flask_cors import CORS

from ultralytics import YOLO



app = Flask(__name__)

CORS(app)



try:


    model = YOLO('models/best.pt')

    print("🚀 Đã nạp thành công bộ não AI: best.pt")

except Exception as e:

    print(f"❌ LỖI: Không tìm thấy file models/best.pt! {e}")



violation_tracker = {"label": None, "start_time": 0}



#

esp32_devices_store = {}



@app.route('/')

def index():

    return render_template('index.html')



@app.route('/ping')

def ping():

    return jsonify({"status": "ok"})



# CỔNG NHẬN TÍN HIỆU TỪ MẠCH ESP32

@app.route('/esp32-wifi-alert', methods=['POST'])

def esp32_alert():

    global esp32_devices_store

    data = request.get_json(silent=True)

    if data and "devices" in data:

        for dev in data["devices"]:

            mac = dev.get("mac")

            if mac:

                esp32_devices_store[mac] = {

                    "mac": mac,

                    "rssi": dev.get("rssi"),

                    "distance_m": dev.get("distance_m"),

                    "randomized": dev.get("randomized"),

                    "last_seen": time.time()

                }

    return jsonify({"status": "ok"})



@app.route('/detect', methods=['POST'])

def detect():

    global violation_tracker, esp32_devices_store

    data = request.get_json(silent=True)

   

    if not data or "image" not in data:

        return jsonify({"error": "Thiếu dữ liệu ảnh"}), 400



    try:

        # Giải mã ảnh từ JavaScript gửi lên

        encoded_data = data["image"].split(',')[1]

        nparr = np.frombuffer(base64.b64decode(encoded_data), np.uint8)

        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)



        # Chạy Yolo26

        results = model.predict(frame, conf=0.25, imgsz=640, verbose=False)[0]



        detections = []

        current_violation = None



        for box in results.boxes:

            # Lấy và làm sạch tên nhãn

            raw_label = str(model.names[int(box.cls[0])]).lower().replace(" ", "").replace("_", "").replace("-", "")

            conf = float(box.conf[0])

            x1, y1, x2, y2 = box.xyxy[0].tolist()



            # Phân loại 4 nhãn

            if "left" in raw_label or "trai" in raw_label:

                display_label, is_bad = "viewleft", True

            elif "right" in raw_label or "phai" in raw_label:

                display_label, is_bad = "viewright", True

            elif "behind" in raw_label or "sau" in raw_label:

                display_label, is_bad = "viewbehind", True

            elif "good" in raw_label or "thang" in raw_label:

                display_label, is_bad = "good", False

            else:

                display_label, is_bad = raw_label, False



            if is_bad and not current_violation:

                current_violation = display_label



            detections.append({

                "bbox": [int(x1), int(y1), int(x2), int(y2)],

                "conf": round(conf, 2),

                "label": display_label,

                "is_cheating": is_bad

            })



        # LOGIC: Đếm ngược 5 giây vi phạm

        trigger_snapshot = False

        if current_violation:

            if violation_tracker["label"] == current_violation:

                if time.time() - violation_tracker["start_time"] >= 5.0:

                    trigger_snapshot = True

                    violation_tracker["start_time"] = time.time() # Reset đếm lại

            else:

                violation_tracker["label"] = current_violation

                violation_tracker["start_time"] = time.time()

        else:

            violation_tracker["label"] = None

            violation_tracker["start_time"] = 0



        # Lọc bỏ thiết bị ESP32 mất tín hiệu (Quá 30s)

        current_time = time.time()

        active_devices = [

            dev for dev in esp32_devices_store.values()

            if current_time - dev["last_seen"] <= 30

        ]



        # Trả kết quả về cho Web vẽ khung & hiển thị Wi-Fi

        return jsonify({

            "detections": detections,

            "trigger_snapshot": trigger_snapshot,

            "wifi_devices": active_devices

        })



    except Exception as e:

        print("❌ Lỗi xử lý khung hình:", e)

        return jsonify({"error": str(e)}), 500



if __name__ == '__main__':

    print("═"*50)

    print("  CYBERVISION AI ĐANG CHẠY - DÀNH CHO Đd")

    print("═"*50)

    app.run(host='0.0.0.0', port=5000, debug=True) 