/* ═══════════════════════════════════════════════════════════════
   CYBERVISION AI — script.js  v3.0
   
   FIX CHÍNH:
   - Lưu video WEBM thật sự (không fake MP4 → lỗi file)
   - OffscreenCanvas tái sử dụng (không GC liên tục)
   - setTimeout đệ quy (không chồng request)
   - Đếm nhãn nhất quán (chỉ tăng khi triggerSnap)
   - Memory: revokeObjectURL đúng lúc
   - drawLoop: cache kích thước, bỏ qua khi cam tắt
   - Race condition video: startViolationRecording trong onstop
═══════════════════════════════════════════════════════════════ */

'use strict';

// ── HẰNG SỐ ───────────────────────────────────────────────────
const DETECT_INTERVAL_MS  = 300;   // Gửi frame mỗi 300ms
const DETECT_W            = 640;   // Chiều rộng frame gửi server
const DETECT_H            = 480;   // Chiều cao frame gửi server
const MAX_LOG_ITEMS       = 40;    // Giới hạn log
const STALE_DETECT_MS     = 500;   // Xóa bbox nếu > 500ms không có tín hiệu
const VIOLATION_LABELS    = new Set(['viewleft', 'viewright', 'viewbehind']);
const VIDEO_TIMESLICE_MS  = 500;   // Lấy chunk video mỗi 500ms

// ── KHO LƯU TRỮ VIDEO VI PHẠM ─────────────────────────────────
// Giữ toàn bộ blob trong RAM để xuất ZIP khi cần.
// Mỗi entry: { blob, fileName, label, timestamp, sizeMB }
const violationStore = [];

// Thêm một video vào kho (gọi sau khi blob sẵn sàng)
function storeViolationVideo(blob, fileName, label) {
  violationStore.push({
    blob,
    fileName,
    label,
    timestamp: new Date(),
    sizeMB: (blob.size / 1_048_576).toFixed(2),
  });
  _updateExportBtn();
}

// Cập nhật trạng thái nút xuất
function _updateExportBtn() {
  const btn    = document.getElementById('btnExportAll');
  const badge  = document.getElementById('exportBadge');
  const count  = violationStore.length;
  if (!btn) return;

  if (count === 0) {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    badge.textContent = '0';
  } else {
    btn.disabled = false;
    btn.style.opacity = '1';
    badge.textContent = count;
    // Nhấp nháy badge khi có video mới
    badge.classList.remove('badge-pulse');
    void badge.offsetWidth; // reflow
    badge.classList.add('badge-pulse');
  }
}

// Xuất toàn bộ video thành ZIP bằng JSZip (CDN)
async function exportAllViolations() {
  if (violationStore.length === 0) return;

  const btn = document.getElementById('btnExportAll');
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Đang nén...';

  try {
    // Tải JSZip nếu chưa có
    if (typeof JSZip === 'undefined') {
      await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }

    const zip      = new JSZip();
    const folder   = zip.folder('CyberVision_ViFam');
    const dateStr  = new Date().toLocaleDateString('vi-VN').replace(/\//g, '-');

    // Thêm từng video vào ZIP
    violationStore.forEach((entry, i) => {
      const paddedIdx = String(i + 1).padStart(3, '0');
      folder.file(`${paddedIdx}_${entry.fileName}`, entry.blob);
    });

    // Tạo file báo cáo TXT kèm theo
    const reportLines = [
      '╔══════════════════════════════════════════╗',
      '║      CYBERVISION AI — BÁO CÁO VI PHẠM   ║',
      '╚══════════════════════════════════════════╝',
      `Ngày xuất  : ${new Date().toLocaleString('vi-VN')}`,
      `Tổng video : ${violationStore.length}`,
      `Good       : ${state.countGood}`,
      `Nhìn trái  : ${state.countLeft}`,
      `Nhìn phải  : ${state.countRight}`,
      `Nhìn sau   : ${state.countBehind}`,
      '',
      '── CHI TIẾT ─────────────────────────────────',
      ...violationStore.map((e, i) =>
        `[${String(i+1).padStart(3,'0')}] ${e.timestamp.toLocaleTimeString('vi-VN')}  ${e.label.toUpperCase().padEnd(12)}  ${e.sizeMB} MB  →  ${e.fileName}`
      ),
    ];
    folder.file('_BaoCaoViPham.txt', reportLines.join('\n'));

    // Generate & download ZIP
    const zipBlob  = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    const zipURL   = URL.createObjectURL(zipBlob);
    const zipName  = `CyberVision_ViFam_${dateStr}_${violationStore.length}video.zip`;
    _triggerDownload(zipURL, zipName);
    setTimeout(() => URL.revokeObjectURL(zipURL), 5000);

    addLog('ok', 'EXPORT', `Đã xuất ZIP: ${violationStore.length} video · ${(zipBlob.size/1_048_576).toFixed(1)} MB`);
  } catch (err) {
    addLog('violation', 'EXPORT ERR', err.message);
    alert('Lỗi khi tạo ZIP: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
    _updateExportBtn();
  }
}

// Xóa toàn bộ kho + cards UI
function clearAllViolations() {
  if (violationStore.length === 0) return;
  if (!confirm(`Xóa toàn bộ ${violationStore.length} video khỏi bộ nhớ?`)) return;

  // Thu hồi ObjectURL các card đang hiển thị
  document.querySelectorAll('.snap-thumb-card[data-url]').forEach(card => {
    URL.revokeObjectURL(card.dataset.url);
    card.remove();
  });

  violationStore.length = 0; // Xóa mảng in-place
  state.snapCount = 0;
  document.getElementById('statSnap').textContent    = 0;
  document.getElementById('snapCounter').textContent = 0;
  document.getElementById('snapGrid').innerHTML =
    '<div class="log-empty" id="snapEmptyMsg">Chưa có video vi phạm</div>';

  _updateExportBtn();
  addLog('info', 'CLEAR', 'Đã xóa toàn bộ video khỏi bộ nhớ');
}

// Load script động (để load JSZip lần đầu)
function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── STATE ──────────────────────────────────────────────────────
const state = {
  cameraOn:   false,
  detecting:  true,
  stream:     null,
  snapCount:  0,

  // Bộ đếm — chỉ tăng khi triggerSnap (nhất quán 4 nhãn)
  countGood:   0,
  countLeft:   0,
  countRight:  0,
  countBehind: 0,

  detectTimer: null,
  fpsInterval: null,
  fpsFrames:   0,
  alertLevel:  'normal',

  // Dữ liệu vẽ bbox (cập nhật từ server, vẽ ở 60fps)
  currentDetections: [],
  lastUpdate:  0,

  // Cache kích thước canvas để tránh layout thrashing
  canvasW: 0,
  canvasH: 0,
};

// ── OFFSCREEN CANVAS (tái sử dụng, tránh GC) ──────────────────
const offscreen = (() => {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(DETECT_W, DETECT_H);
  }
  const c = document.createElement('canvas');
  c.width = DETECT_W; c.height = DETECT_H;
  return c;
})();
const offCtx = offscreen.getContext('2d');

// ── QUẢN LÝ QUAY VIDEO VI PHẠM ─────────────────────────────────
// 
// VẤN ĐỀ GỐC: MediaRecorder KHÔNG thực sự hỗ trợ video/mp4
// trên hầu hết trình duyệt (Chrome/Firefox). Khi dùng mimeType
// 'video/mp4', nó SẼ báo lỗi hoặc silently fallback sang WebM
// nhưng file đặt tên .mp4 → file bị hỏng khi mở bằng media player.
//
// FIX ĐÚNG: Luôn ghi WebM, đặt tên .webm → file chạy được 100%.
// WebM được hỗ trợ native trên Chrome, Firefox, Edge.
// Người dùng có thể convert sang MP4 bằng VLC hoặc ffmpeg nếu cần.

const recorder = {
  instance:     null,
  chunks:       [],
  active:       false,
  pendingLabel: null,
  mimeType:     '',
};

function getBestMimeType() {
  // Ưu tiên VP9 (chất lượng cao), fallback VP8, fallback WebM mặc định
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function startViolationRecording() {
  if (!state.stream || recorder.active) return;

  const mimeType = getBestMimeType();
  if (!mimeType) {
    addLog('info', 'REC', 'Trình duyệt không hỗ trợ MediaRecorder WebM');
    return;
  }

  recorder.chunks   = [];
  recorder.mimeType = mimeType;

  try {
    recorder.instance = new MediaRecorder(state.stream, {
      mimeType,
      videoBitsPerSecond: 1_500_000, // 1.5 Mbps — đủ rõ, không quá nặng
    });

    recorder.instance.ondataavailable = e => {
      if (e.data && e.data.size > 0) recorder.chunks.push(e.data);
    };

    recorder.instance.start(VIDEO_TIMESLICE_MS);
    recorder.active = true;
  } catch (err) {
    addLog('info', 'REC ERR', err.message);
    recorder.active = false;
  }
}

function stopAndSaveViolationRecording(label) {
  if (!recorder.instance || !recorder.active) return;

  recorder.active       = false;
  recorder.pendingLabel = label;

  recorder.instance.onstop = () => {
    const chunks = recorder.chunks;
    recorder.chunks = [];

    if (chunks.length === 0) {
      // Không có dữ liệu → bỏ qua, không tạo file rác
      _maybeRestartRecording();
      return;
    }

    const mimeType = recorder.mimeType;
    const blob     = new Blob(chunks, { type: mimeType });

    // ✓ Đặt đúng đuôi .webm (không fake .mp4)
    const ext      = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const timeStr  = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    const lbl      = recorder.pendingLabel || label;
    const fileName = `CyberVision_${lbl.toUpperCase()}_${timeStr}.${ext}`;

    const url = URL.createObjectURL(blob);
    _triggerDownload(url, fileName);
    addVideoCard(url, fileName, lbl, blob.size);

    // Lưu vào kho để xuất ZIP sau
    storeViolationVideo(blob, fileName, lbl);

    _maybeRestartRecording();
  };

  recorder.instance.stop();
}

function discardViolationRecording() {
  if (!recorder.instance) return;
  recorder.instance.onstop = null; // Hủy callback lưu file
  if (recorder.active) recorder.instance.stop();
  recorder.active = false;
  recorder.chunks = [];
  recorder.instance = null;
}

function _triggerDownload(url, fileName) {
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href     = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  // Xóa thẻ sau khi click, nhưng GIỮ url để video card dùng
  setTimeout(() => document.body.removeChild(a), 200);
}

function _maybeRestartRecording() {
  // Nếu vẫn đang vi phạm → bắt đầu phiên quay mới ngay
  if (state.alertLevel === 'violation' && state.cameraOn) {
    startViolationRecording();
  }
}

// ── CARD VIDEO BẰNG CHỨNG ──────────────────────────────────────
function addVideoCard(url, fileName, label, byteSize) {
  const now     = new Date().toTimeString().slice(0, 8);
  const sizeMB  = (byteSize / 1_048_576).toFixed(2);
  const isBad   = VIOLATION_LABELS.has(label) || label === 'WIFI_ALERT';
  const badgeColor = isBad ? 'var(--red)' : 'var(--green)';

  const card = document.createElement('div');
  card.className = 'snap-thumb-card' + (isBad ? ' violation' : '');
  card.dataset.url = url; // Lưu để revokeObjectURL sau

  card.innerHTML = `
    <video
      src="${url}"
      controls
      loop
      muted
      playsinline
      style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#000;border-bottom:1px solid var(--border)"
    ></video>
    <div class="snap-meta" style="flex-direction:column;align-items:stretch;gap:6px;padding:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:4px">
        <span class="snap-meta-time">${now}</span>
        <span class="snap-meta-badge" style="background:${badgeColor};color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:700">
          ${label.toUpperCase()} · ${sizeMB}MB
        </span>
      </div>
      <a
        href="${url}"
        download="${fileName}"
        style="display:block;background:var(--red);color:#fff;text-align:center;padding:6px 8px;font-size:11px;text-decoration:none;border-radius:4px;font-weight:bold;font-family:var(--font-mono)"
      >📥 TẢI WEBM XUỐNG</a>
    </div>
  `;

  const grid = document.getElementById('snapGrid');
  grid.prepend(card);

  // Giải phóng ObjectURL khi card bị remove khỏi DOM
  new MutationObserver((_, obs) => {
    if (!document.body.contains(card)) {
      URL.revokeObjectURL(url);
      obs.disconnect();
    }
  }).observe(grid, { childList: true });

  // Cập nhật bộ đếm
  state.snapCount++;
  document.getElementById('statSnap').textContent    = state.snapCount;
  document.getElementById('snapCounter').textContent = state.snapCount;
  document.getElementById('snapEmptyMsg')?.remove();
}

// ── DOM REFS ───────────────────────────────────────────────────
const webcam        = document.getElementById('webcam');
const overlayCanvas = document.getElementById('overlay');
const ctx           = overlayCanvas.getContext('2d');
const camOffline    = document.getElementById('camOffline');
const logList       = document.getElementById('logList');
const confFill      = document.getElementById('confFill');
const confVal       = document.getElementById('confVal');
const alertBadge    = document.getElementById('alertBadge');
const alertText     = document.getElementById('alertText');
const aiPill        = document.getElementById('aiPill');
const aiStatusText  = document.getElementById('aiStatusText');
const fpsDisplay    = document.getElementById('fpsDisplay');
const serverStatus  = document.getElementById('serverStatus');
const statGood      = document.getElementById('statGood');
const statLeft      = document.getElementById('statLeft');
const statRight     = document.getElementById('statRight');
const statBehind    = document.getElementById('statBehind');

// ── UI ESP32 MỚI ────────────────────────────────────────────────
const wifiPill       = document.getElementById('wifiPill');
const wifiPulse      = document.getElementById('wifiPulse');
const wifiStatusText = document.getElementById('wifiStatusText');
const wifiDeviceCount= document.getElementById('wifiDeviceCount');
const wifiDeviceList = document.getElementById('wifiDeviceList');

// ── ĐỒNG HỒ ───────────────────────────────────────────────────
setInterval(() => {
  document.getElementById('clock').textContent =
    new Date().toTimeString().slice(0, 8);
}, 1000);

// ── PING SERVER ────────────────────────────────────────────────
async function pingServer() {
  try {
    const res = await fetch('/ping', { signal: AbortSignal.timeout(3000) });
    serverStatus.textContent = res.ok ? 'Online ✓' : `Lỗi ${res.status}`;
    serverStatus.style.color = res.ok ? 'var(--green)' : 'var(--red)';
  } catch {
    serverStatus.textContent = 'Offline — chạy app.py';
    serverStatus.style.color = 'var(--red)';
  }
}
pingServer();
setInterval(pingServer, 8000);

// ── CAMERA ─────────────────────────────────────────────────────
async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    webcam.srcObject = state.stream;

    // Đợi metadata load xong mới đọc kích thước
    await new Promise((resolve, reject) => {
      webcam.onloadedmetadata = resolve;
      webcam.onerror = reject;
    });

    // Khởi tạo canvas đúng kích thước
    overlayCanvas.width  = state.canvasW = webcam.videoWidth;
    overlayCanvas.height = state.canvasH = webcam.videoHeight;

    state.cameraOn = true;
    camOffline.style.display = 'none';
    document.getElementById('btnCam').classList.add('active');
    addLog('info', 'CAMERA', `Khởi động thành công — ${webcam.videoWidth}×${webcam.videoHeight}`);

    if (state.detecting) startDetectionLoop();
    startFPSCounter();
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'Chưa cấp quyền camera'
      : err.message || 'Không truy cập được camera';
    addLog('violation', 'CAMERA ERR', msg);
    alert(`Không thể mở camera: ${msg}`);
  }
}

function toggleCamera() {
  if (state.cameraOn) {
    state.stream?.getTracks().forEach(t => t.stop());
    webcam.srcObject = null;
    state.cameraOn   = false;

    stopDetectionLoop();
    discardViolationRecording();
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    state.currentDetections = [];

    camOffline.style.display = 'flex';
    document.getElementById('btnCam').classList.remove('active');
    addLog('info', 'CAMERA', 'Camera đã tắt');
  } else {
    startCamera();
  }
}

// ── DETECTION LOOP (setTimeout đệ quy — tránh request chồng) ──
function startDetectionLoop() {
  if (state.detectTimer) return; // Đã chạy rồi
  aiPill.style.borderColor  = 'rgba(0,255,180,.3)';
  aiPill.style.color        = 'var(--accent)';
  aiStatusText.textContent  = 'AI: Đang phân tích...';
  _scheduleDetect();
}

function _scheduleDetect() {
  state.detectTimer = setTimeout(async () => {
    if (state.cameraOn && state.detecting) {
      await _detectFrame();
      _scheduleDetect(); // Lặp tiếp — chỉ sau khi request xong
    } else {
      state.detectTimer = null;
    }
  }, DETECT_INTERVAL_MS);
}

function stopDetectionLoop() {
  clearTimeout(state.detectTimer);
  state.detectTimer = null;
  aiStatusText.textContent = 'AI: Đã dừng';
}

function toggleDetection() {
  state.detecting = !state.detecting;
  const btn = document.getElementById('btnDetect');
  if (state.detecting) {
    btn.classList.add('active');
    if (state.cameraOn) startDetectionLoop();
  } else {
    btn.classList.remove('active');
    stopDetectionLoop();
  }
}

// ── GỬI FRAME LÊN SERVER ──────────────────────────────────────
async function _detectFrame() {
  // Chọn nguồn: MJPEG img hoặc webcam
  const source = (state._mjpegImg && state._mjpegImg.style.display !== 'none')
    ? state._mjpegImg
    : webcam;

  if (source === webcam && webcam.readyState < 2) return; // Video chưa sẵn sàng
  state.fpsFrames++;

  // Vẽ lên OffscreenCanvas đã resize về 640×480
  offCtx.drawImage(source, 0, 0, DETECT_W, DETECT_H);

  let imageData;
  try {
    if (offscreen instanceof OffscreenCanvas) {
      // Async, không block UI thread
      const blob  = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
      const buf   = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Encode theo chunk tránh stack overflow
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      imageData = 'data:image/jpeg;base64,' + btoa(bin);
    } else {
      // Fallback HTMLCanvas (đã nhỏ 640×480 → ít giật hơn)
      imageData = offscreen.toDataURL('image/jpeg', 0.55);
    }
  } catch {
    return; // Bỏ qua frame lỗi encode
  }

  try {
    const res = await fetch('/detect', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ image: imageData }),
      signal:  AbortSignal.timeout(5000), // Timeout 5s tránh treo
    });
    if (!res.ok) return;
    _handleResult(await res.json());
  } catch {
    // Bỏ qua lỗi mạng / timeout tạm thời
  }
}

// ── XỬ LÝ KẾT QUẢ TỪ SERVER ──────────────────────────────────
function _handleResult(data) {
  const detections  = Array.isArray(data.detections) ? data.detections : [];
  const triggerSnap = Boolean(data.trigger_snapshot);

  // Cập nhật buffer vẽ
  state.currentDetections = detections;
  state.lastUpdate        = Date.now();

  // Confidence bar
  const maxConf = detections.length > 0
    ? Math.max(...detections.map(d => +d.conf || 0))
    : 0;
  const confPct = Math.round(maxConf * 100);
  confFill.style.width = confPct + '%';
  confVal.textContent  = confPct ? confPct + '%' : '--';

  // Xác định có vi phạm không
  const hasViolation = detections.some(
    d => d.is_cheating || VIOLATION_LABELS.has(d.label)
  );
  const alertLevel = hasViolation ? 'violation' : 'normal';

  // Quản lý ghi hình
  if (hasViolation && !recorder.active) {
    startViolationRecording();
  } else if (!hasViolation && recorder.active) {
    discardViolationRecording();
  }

  // Khi server báo đủ 5 giây vi phạm → lưu video + cập nhật bộ đếm
  if (triggerSnap) {
    const badDet = detections.find(d => d.is_cheating || VIOLATION_LABELS.has(d.label))
                || detections[0];
    const lbl    = badDet?.label || 'violation';

    // ✓ Tất cả nhãn chỉ tăng khi triggerSnap — nhất quán
    if (lbl === 'good')       { state.countGood++;   statGood.textContent   = state.countGood;   }
    if (lbl === 'viewleft')   { state.countLeft++;   statLeft.textContent   = state.countLeft;   }
    if (lbl === 'viewright')  { state.countRight++;  statRight.textContent  = state.countRight;  }
    if (lbl === 'viewbehind') { state.countBehind++; statBehind.textContent = state.countBehind; }

    addLog('violation', lbl.toUpperCase(),
      `Conf: ${confPct}% — Giữ tư thế > 5 giây → Đã lưu video WEBM`);

    // Dừng phiên hiện tại + lưu file (sẽ tự restart trong onstop)
    stopAndSaveViolationRecording(lbl);
  }

  // Cập nhật badge & màu sắc UI
  _setAlertBadge(alertLevel, detections);
  document.body.classList.toggle('level-violation', alertLevel === 'violation');
  confFill.style.background = alertLevel === 'violation'
    ? 'linear-gradient(90deg,var(--red),#ff6b6b)'
    : 'linear-gradient(90deg,var(--accent),var(--accent2))';
state.alertLevel = alertLevel;

  // ── XỬ LÝ HIỂN THỊ DANH SÁCH THIẾT BỊ WI-FI (ESP32) ────────────────
  const wifiDevices = data.wifi_devices || [];
  
  if (wifiDeviceCount && wifiDeviceList) {
      wifiDeviceCount.textContent = wifiDevices.length;
      
      if (wifiDevices.length === 0) {
          wifiDeviceList.innerHTML = '<div class="log-empty">Không phát hiện thiết bị phát sóng</div>';
          if (wifiPill) {
              wifiPill.style.borderColor = 'rgba(0, 191, 255, 0.3)';
              wifiPill.style.color = 'var(--blue)';
              if (wifiPulse) wifiPulse.style.background = 'var(--blue)';
              if (wifiStatusText) wifiStatusText.textContent = 'ESP32: Đang quét...';
          }
      } else {
          let hasSuspicious = false;
          wifiDeviceList.innerHTML = wifiDevices.map(dev => {
              const isSuspicious = !dev.randomized; 
              if (isSuspicious) hasSuspicious = true;
              const typeLabel    = dev.randomized ? 'RAND MAC' : 'REAL MAC';
              const badgeClass   = dev.randomized ? 'w' : 'v'; 
              
              return `
                  <div class="log-item ${isSuspicious ? 'violation' : 'info'}" style="padding: 6px 10px; margin: 0;">
                      <div class="log-header">
                          <span class="log-type" style="font-size: 11px; letter-spacing: 0.5px;">📱 ${dev.mac}</span>
                          <span class="snap-meta-badge ${badgeClass}" style="font-size: 8px; padding: 1px 4px;">${typeLabel}</span>
                      </div>
                      <div class="log-desc" style="display: flex; justify-content: space-between; font-size: 10px; margin-top: 3px; color: var(--text-dim);">
                          <span>📶 ${dev.rssi} dBm</span>
                          <span>~${dev.distance_m}m</span>
                      </div>
                  </div>
              `;
          }).join('');

          if (wifiPill) {
              if (hasSuspicious) {
                  wifiPill.style.borderColor = 'rgba(255, 59, 92, 0.3)';
                  wifiPill.style.color = 'var(--red)';
                  if (wifiPulse) wifiPulse.style.background = 'var(--red)';
                  if (wifiStatusText) wifiStatusText.textContent = '⚠ WIFI LẠ!';
                  
                  // Kích hoạt ghi hình khẩn cấp nếu có sóng thật
                  if (!recorder.active) {
                      startViolationRecording();
                  } else {
                      if (!state.lastWifiRecord || Date.now() - state.lastWifiRecord > 6000) {
                          addLog('violation', 'ESP32 WIFI', `Phát hiện sóng lạ -> Đã lưu video WEBM`);
                          stopAndSaveViolationRecording('WIFI_ALERT');
                          state.lastWifiRecord = Date.now();
                      }
                  }
              } else {
                  wifiPill.style.borderColor = 'rgba(0, 191, 255, 0.3)';
                  wifiPill.style.color = 'var(--blue)';
                  if (wifiPulse) wifiPulse.style.background = 'var(--blue)';
                  if (wifiStatusText) wifiStatusText.textContent = 'ESP32: Đang quét...';
              }
          }
      }
  }
}

// ── VẼ BBOX — KHÔNG NHẤP NHÁY ────────────────────────────────
//
// NGUYÊN NHÂN NHẤP NHÁY:
//   clearRect chạy 60fps nhưng data cập nhật 300ms/lần
//   → 17 frame liên tiếp vẽ trống (bbox biến mất) rồi 1 frame có bbox
//
// GIẢI PHÁP: Double-buffer + Lerp smoothing
//   - displayBoxes: mảng bbox đang hiển thị (KHÔNG xóa khi thiếu data)
//   - Khi có data mới → lerp (nội suy) từ vị trí cũ → mới theo thời gian
//   - Khi mất tín hiệu → fade out alpha dần, KHÔNG xóa đột ngột
//   - clearRect → compositeOperation 'copy' với alpha thấp (motion blur nhẹ)

// Buffer hiển thị — tồn tại độc lập với state.currentDetections
const displayBoxes = new Map(); // key = label+gridCell (ổn định theo vị trí), value = { x,y,w,h, tx,ty,tw,th, alpha, color, label, conf }

const LERP_SPEED   = 0.18;  // 0–1: càng cao càng nhanh bám theo (0.18 = mượt)
const FADE_SPEED   = 0.06;  // Tốc độ fade out khi mất tín hiệu
const FADE_IN_SPEED= 0.12;  // Tốc độ fade in khi xuất hiện
const IOU_MERGE_THRESH = 0.45; // Ngưỡng IoU để gộp box chồng nhau
let   _lastDrawTime = 0;

// ── Tính IoU giữa 2 box [x,y,w,h] ─────────────────────────────
function _iou(a, b) {
  const ax2 = a.tx + a.tw, ay2 = a.ty + a.th;
  const bx2 = b.tx + b.tw, by2 = b.ty + b.th;
  const ix1 = Math.max(a.tx, b.tx), iy1 = Math.max(a.ty, b.ty);
  const ix2 = Math.min(ax2, bx2),   iy2 = Math.min(ay2, by2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const union  = a.tw * a.th + b.tw * b.th - inter;
  return union > 0 ? inter / union : 0;
}

// ── Key ổn định dựa trên label + ô lưới 8×6 (không dùng index) ─
// Chia không gian detect thành lưới 8 cột × 6 hàng.
// Box nào thuộc ô nào → key cố định, tránh đổi key khi mảng xáo trộn.
function _stableKey(label, tx, ty) {
  const col = Math.min(7, Math.floor(tx / (DETECT_W / 8)));
  const row = Math.min(5, Math.floor(ty / (DETECT_H / 6)));
  return `${label}_${col}_${row}`;
}

// ── NMS đơn giản: loại bỏ box chồng nhau, giữ box conf cao nhất ─
function _nmsDetections(detections) {
  if (detections.length <= 1) return detections;

  // Sắp xếp giảm dần theo conf
  const sorted = [...detections].sort((a, b) => (+b.conf || 0) - (+a.conf || 0));
  const kept = [];

  for (const det of sorted) {
    const [x1, y1, x2, y2] = det.bbox;
    const candidate = { tx: x1, ty: y1, tw: x2 - x1, th: y2 - y1 };
    const overlap = kept.some(k => {
      const [kx1, ky1, kx2, ky2] = k.bbox;
      const kBox = { tx: kx1, ty: ky1, tw: kx2 - kx1, th: ky2 - ky1 };
      return _iou(candidate, kBox) > IOU_MERGE_THRESH;
    });
    if (!overlap) kept.push(det);
  }
  return kept;
}

function _drawLoop(timestamp) {
  requestAnimationFrame(_drawLoop);

  // Xác định nguồn video hiện tại (webcam hoặc mjpeg img)
  const _src = (state._mjpegImg && state._mjpegImg.style.display !== 'none')
    ? state._mjpegImg : webcam;
  const _videoWidth  = (_src === webcam) ? webcam.videoWidth  : (_src.naturalWidth  || 640);
  const _videoHeight = (_src === webcam) ? webcam.videoHeight : (_src.naturalHeight || 480);

  if (!state.cameraOn || (!_videoWidth && !webcam.videoWidth)) {
    // Camera tắt: xóa hết buffer
    displayBoxes.clear();
    return;
  }

  // ── Resize canvas chỉ khi cần ──────────────────────────────
  const vw = _videoWidth || webcam.videoWidth;
  const vh = _videoHeight || webcam.videoHeight;
  if (vw !== state.canvasW || vh !== state.canvasH) {
    overlayCanvas.width  = state.canvasW = vw;
    overlayCanvas.height = state.canvasH = vh;
    ctx.font = 'bold 14px monospace'; // Reset sau khi resize
  }

  // ── Delta time để lerp không phụ thuộc frame rate ──────────
  const now   = timestamp || performance.now();
  const dt    = Math.min((now - _lastDrawTime) / 16.67, 3); // chuẩn hóa về 60fps
  _lastDrawTime = now;

  const scaleX = state.canvasW / DETECT_W;
  const scaleY = state.canvasH / DETECT_H;

  // ── Cập nhật target từ data server mới nhất ────────────────
  const isStale = (now - state.lastUpdate) > STALE_DETECT_MS;
  // Lọc NMS trước khi hiển thị để triệt box chồng nhau
  const incoming = isStale ? [] : _nmsDetections(state.currentDetections);

  // Đánh dấu tất cả box hiện tại là "không tìm thấy"
  displayBoxes.forEach(b => { b.found = false; });

  incoming.forEach(det => {
    const [x1, y1, x2, y2] = det.bbox;
    const tx = x1 * scaleX;
    const ty = y1 * scaleY;
    const tw = (x2 - x1) * scaleX;
    const th = (y2 - y1) * scaleY;

    const isBad = det.is_cheating || VIOLATION_LABELS.has(det.label);
    const color = isBad ? '#ff3b5c' : '#00ffb4';
    // Key ổn định theo label + vị trí ô lưới (không dùng index)
    const key   = _stableKey(det.label, x1, y1);

    if (displayBoxes.has(key)) {
      // Cập nhật target — KHÔNG nhảy vị trí đột ngột
      const b = displayBoxes.get(key);
      b.tx = tx; b.ty = ty; b.tw = tw; b.th = th;
      b.color = color;
      b.label = det.label;
      b.conf  = +det.conf || 0;
      b.found = true;
    } else {
      // Box mới: xuất hiện tại đúng vị trí, alpha = 0 → fade in
      displayBoxes.set(key, {
        x: tx, y: ty, w: tw, h: th,   // vị trí hiện tại (được lerp)
        tx, ty, tw, th,                // vị trí target
        alpha: 0,                      // bắt đầu trong suốt
        color, label: det.label,
        conf: +det.conf || 0,
        found: true,
      });
    }
  });

  // Fade out các box không còn trong data
  displayBoxes.forEach((b, key) => {
    if (!b.found) {
      b.alpha -= FADE_SPEED * dt;
      if (b.alpha <= 0) displayBoxes.delete(key);
    }
  });

  // ── Xóa canvas sạch 1 lần mỗi frame ───────────────────────
  ctx.clearRect(0, 0, state.canvasW, state.canvasH);

  if (displayBoxes.size === 0) return;

  // ── Lerp + vẽ tất cả box ───────────────────────────────────
  const lerpF = 1 - Math.pow(1 - LERP_SPEED, dt); // frame-rate independent lerp

  displayBoxes.forEach(b => {
    // Nội suy vị trí
    b.x += (b.tx - b.x) * lerpF;
    b.y += (b.ty - b.y) * lerpF;
    b.w += (b.tw - b.w) * lerpF;
    b.h += (b.th - b.h) * lerpF;

    // Fade in nếu mới xuất hiện
    if (b.found) b.alpha = Math.min(1, b.alpha + FADE_IN_SPEED * dt);

    const a = Math.max(0, Math.min(1, b.alpha));
    if (a < 0.01) return;

    // ── Vẽ khung ───────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = a;

    // Shadow nhẹ để bbox nổi bật trên nền phức tạp
    ctx.shadowColor  = b.color;
    ctx.shadowBlur   = 6;

    ctx.strokeStyle  = b.color;
    ctx.lineWidth    = 2.5;
    ctx.strokeRect(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h));

    // Tắt shadow trước khi vẽ text (tránh blur chữ)
    ctx.shadowBlur = 0;

    // ── Vẽ nhãn ────────────────────────────────────────────
    const confPct   = Math.round(b.conf * 100);
    const labelText = `${b.label}  ${confPct}%`;
    ctx.font        = 'bold 13px monospace';
    const tw        = ctx.measureText(labelText).width;
    const tagH      = 20;
    const tagX      = Math.round(b.x);
    const tagY      = Math.round(b.y) - tagH;

    // Nền nhãn
    ctx.fillStyle = b.color;
    ctx.fillRect(tagX, tagY, tw + 10, tagH);

    // Chữ
    ctx.fillStyle = b.color === '#00ffb4' ? '#000' : '#fff';
    ctx.fillText(labelText, tagX + 5, tagY + 14);

    ctx.restore();
  });
}
requestAnimationFrame(_drawLoop);

// ── ALERT BADGE ────────────────────────────────────────────────
function _setAlertBadge(level, detections) {
  const dot = alertBadge.querySelector('.vb-dot');
  if (level === 'violation') {
    dot.className = 'vb-dot red';
    const bad = detections.find(d => d.is_cheating || VIOLATION_LABELS.has(d.label));
    alertText.textContent = bad ? bad.label.toUpperCase() : 'VI PHẠM';
  } else {
    dot.className = 'vb-dot grey';
    alertText.textContent = 'BÌNH THƯỜNG';
  }
}

// ── LOG ────────────────────────────────────────────────────────
function addLog(type, title, desc) {
  // Xóa placeholder
  logList.querySelector('.log-empty')?.remove();

  const now  = new Date().toTimeString().slice(0, 8);
  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.innerHTML = `
    <div class="log-header">
      <span class="log-type">${title}</span>
      <span class="log-time">${now}</span>
    </div>
    <div class="log-desc">${desc}</div>
  `;
  logList.prepend(item);

  // Giới hạn đúng — chỉ đếm log-item thật
  const items = logList.querySelectorAll('.log-item');
  if (items.length > MAX_LOG_ITEMS) {
    items[items.length - 1].remove();
  }
}

function clearLog() {
  logList.innerHTML = '<div class="log-empty">Nhật ký đã được xóa</div>';
}

// ── FPS COUNTER ────────────────────────────────────────────────
function startFPSCounter() {
  clearInterval(state.fpsInterval);
  state.fpsInterval = setInterval(() => {
    fpsDisplay.textContent = state.fpsFrames; // Frame thực tế/giây
    state.fpsFrames = 0;
  }, 1000);
}

// ── KẾT THÚC PHIÊN ────────────────────────────────────────────
function endSession() {
  if (!confirm('Kết thúc phiên giám sát?')) return;

  stopDetectionLoop();
  clearInterval(state.fpsInterval);
  discardViolationRecording();

  const summary = [
    `Good: ${state.countGood}`,
    `Trái: ${state.countLeft}`,
    `Phải: ${state.countRight}`,
    `Sau: ${state.countBehind}`,
    `Video: ${state.snapCount}`,
  ].join(' · ');

  addLog('info', 'SESSION END', summary);
  document.querySelector('.rec-badge').style.opacity = '.3';
  document.querySelector('.conn-dot').style.background = 'var(--grey)';
  document.getElementById('connText').textContent = 'ĐÃ DỪNG';
  aiStatusText.textContent = 'AI: Đã dừng';
}


// ══════════════════════════════════════════════════════════════════
// QUẢN LÝ NGUỒN VIDEO — WEBCAM & IP CAMERA / STREAM
// ══════════════════════════════════════════════════════════════════

const sourceState = {
  mode: 'webcam',          // 'webcam' | 'stream'
  streamType: 'mjpeg',     // 'mjpeg' | 'hls' | 'flask'
  streamUrl: '',
  selectedDeviceId: null,
  hlsInstance: null,
};

// ── MỞ / ĐÓNG MODAL ────────────────────────────────────────────
function openSourceModal() {
  const modal = document.getElementById('sourceModal');
  modal.style.display = 'flex';
  _loadDeviceList();
  _updateSourceCurrentIndicator();
}

function closeSourceModal(e) {
  if (e && e.target !== document.getElementById('sourceModal')) return;
  document.getElementById('sourceModal').style.display = 'none';
}

// ── CHUYỂN TAB ─────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tabWebcam').classList.toggle('active', tab === 'webcam');
  document.getElementById('tabIp').classList.toggle('active', tab === 'ip');
  document.getElementById('panelWebcam').style.display = tab === 'webcam' ? '' : 'none';
  document.getElementById('panelIp').style.display = tab === 'ip' ? '' : 'none';
}

// ── DANH SÁCH THIẾT BỊ ─────────────────────────────────────────
async function _loadDeviceList() {
  const list = document.getElementById('deviceList');
  try {
    // Cần quyền để liệt kê nhãn thiết bị
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {});

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    if (videoDevices.length === 0) {
      list.innerHTML = '<div class="source-loading">Không tìm thấy thiết bị video</div>';
      return;
    }

    list.innerHTML = videoDevices.map((d, i) => `
      <div class="source-device-item ${sourceState.selectedDeviceId === d.deviceId ? 'selected' : ''}"
           onclick="selectDevice('${d.deviceId}', this)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
        </svg>
        ${d.label || `Camera ${i + 1}`}
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="source-loading" style="color:var(--red)">Lỗi: ${err.message}</div>`;
  }
}

function selectDevice(deviceId, el) {
  sourceState.selectedDeviceId = deviceId;
  document.querySelectorAll('.source-device-item').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
}

// ── CHỌN LOẠI STREAM ───────────────────────────────────────────
function selectStreamType(type) {
  sourceState.streamType = type;
  ['mjpeg', 'hls', 'flask'].forEach(t => {
    document.getElementById(`type${t.charAt(0).toUpperCase() + t.slice(1)}`)
      ?.classList.toggle('active', t === type);
  });

  const hints = {
    mjpeg:  'Ví dụ: http://192.168.1.x:8080/video (MJPEG — IP Webcam App)',
    hls:    'Ví dụ: http://server/stream/index.m3u8 (cần hls.js nếu không hỗ trợ native)',
    flask:  'Ví dụ: http://localhost:5000/video_feed (Flask MJPEG proxy từ RTSP)',
  };
  document.getElementById('streamHint').textContent = hints[type] || '';
}

// ── DÁN URL ────────────────────────────────────────────────────
async function pasteUrl() {
  try {
    const text = await navigator.clipboard.readText();
    document.getElementById('streamUrlInput').value = text.trim();
  } catch {
    alert('Không thể đọc clipboard. Hãy dán thủ công bằng Ctrl+V.');
  }
}

function applyPreset(url) {
  document.getElementById('streamUrlInput').value = url;
  // Auto-detect loại
  if (url.includes('.m3u8')) selectStreamType('hls');
  else if (url.includes('/video_feed')) selectStreamType('flask');
  else selectStreamType('mjpeg');
}

// ── KIỂM TRA KẾT NỐI ──────────────────────────────────────────
async function testStreamConnection() {
  const url = document.getElementById('streamUrlInput').value.trim();
  if (!url) { alert('Vui lòng nhập URL stream.'); return; }

  const statusEl = document.getElementById('testStatus');
  const iconEl   = document.getElementById('testIcon');
  const msgEl    = document.getElementById('testMsg');

  statusEl.style.display = 'flex';
  statusEl.style.borderColor = 'rgba(255,255,255,.07)';
  iconEl.textContent = '⏳';
  msgEl.textContent  = 'Đang kiểm tra kết nối...';

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch(url, { signal: ctrl.signal, mode: 'no-cors' });
    clearTimeout(tid);
    iconEl.textContent = '✅';
    msgEl.textContent  = 'Kết nối thành công! Bấm "KẾT NỐI STREAM" để bắt đầu.';
    statusEl.style.borderColor = 'rgba(0,255,180,.25)';
  } catch (err) {
    if (err.name === 'AbortError') {
      iconEl.textContent = '⏱';
      msgEl.textContent  = 'Timeout — Máy chủ không phản hồi trong 5 giây.';
    } else {
      // no-cors thành công nhưng opaque, hoặc lỗi mạng thật
      iconEl.textContent = '⚠️';
      msgEl.textContent  = 'Không thể xác nhận (CORS). Thử kết nối trực tiếp.';
    }
    statusEl.style.borderColor = 'rgba(255,59,92,.25)';
  }
}

// ── KẾT NỐI WEBCAM ─────────────────────────────────────────────
async function connectWebcam() {
  // Tắt stream hiện tại nếu có
  _teardownCurrentSource();

  const constraints = {
    video: sourceState.selectedDeviceId
      ? { deviceId: { exact: sourceState.selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    webcam.srcObject = state.stream;
    webcam.style.display = '';

    await new Promise((res, rej) => {
      webcam.onloadedmetadata = res;
      webcam.onerror = rej;
    });

    overlayCanvas.width  = state.canvasW = webcam.videoWidth;
    overlayCanvas.height = state.canvasH = webcam.videoHeight;
    state.cameraOn = true;

    camOffline.style.display = 'none';
    document.getElementById('btnCam').classList.add('active');
    document.getElementById('sourceBadge').style.display = 'none';
    document.getElementById('camBadgeText').textContent = 'CAM_01 · HD';

    sourceState.mode = 'webcam';
    _updateSourceCurrentIndicator();
    addLog('info', 'WEBCAM', `Kết nối thành công — ${webcam.videoWidth}×${webcam.videoHeight}`);

    if (state.detecting) startDetectionLoop();
    startFPSCounter();
    document.getElementById('sourceModal').style.display = 'none';
  } catch (err) {
    const msg = err.name === 'NotAllowedError' ? 'Chưa cấp quyền camera' : err.message;
    addLog('violation', 'WEBCAM ERR', msg);
    alert('Không thể mở webcam: ' + msg);
  }
}

// ── KẾT NỐI STREAM ─────────────────────────────────────────────
async function connectStream() {
  const url = document.getElementById('streamUrlInput').value.trim();
  if (!url) { alert('Vui lòng nhập URL stream.'); return; }

  _teardownCurrentSource();

  const type = sourceState.streamType;
  sourceState.streamUrl = url;

  camOffline.style.display = 'none';

  if (type === 'hls') {
    await _connectHLS(url);
  } else {
    // MJPEG hoặc Flask proxy — gán src trực tiếp vào <video> hoặc dùng <img>
    await _connectMJPEG(url);
  }
}

// KẾT NỐI MJPEG / FLASK (dùng <img> tag vì <video> không hỗ trợ MJPEG)
function _connectMJPEG(url) {
  return new Promise((resolve) => {
    // MJPEG cần dùng thẻ <img> thay vì <video>
    // Ẩn <video>, hiển thị thẻ <img> overlay lên canvas area
    webcam.style.display = 'none';

    let imgEl = document.getElementById('mjpegImg');
    if (!imgEl) {
      imgEl = document.createElement('img');
      imgEl.id = 'mjpegImg';
      imgEl.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;z-index:1;';
      document.getElementById('videoContainer').appendChild(imgEl);
    }

    imgEl.onerror = () => {
      addLog('violation', 'STREAM ERR', `Không tải được: ${url}`);
      imgEl.style.display = 'none';
      camOffline.style.display = 'flex';
    };

    imgEl.onload = () => {
      // Dùng kích thước img để set canvas
      if (imgEl.naturalWidth) {
        overlayCanvas.width  = state.canvasW = imgEl.naturalWidth  || 640;
        overlayCanvas.height = state.canvasH = imgEl.naturalHeight || 480;
      }
    };

    imgEl.src = url;
    imgEl.style.display = '';
    state.cameraOn = true;

    // Cho detection loop: vẽ img lên offscreen canvas mỗi frame
    _setupMJPEGDetection(imgEl);

    _onStreamConnected(url, 'MJPEG');
    resolve();
  });
}

// Vẽ MJPEG img lên offscreen để gửi lên server detect
function _setupMJPEGDetection(imgEl) {
  // Ghi đè _detectFrame để dùng imgEl thay vì webcam
  state._originalDetectTarget = 'webcam';
  state._mjpegImg = imgEl;
}

// KẾT NỐI HLS
async function _connectHLS(url) {
  webcam.style.display = '';

  const hlsSupported = webcam.canPlayType('application/vnd.apple.mpegurl');

  if (hlsSupported) {
    // Safari hỗ trợ native
    webcam.src = url;
    webcam.srcObject = null;
  } else {
    // Chrome/Firefox cần hls.js
    try {
      await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.7/hls.min.js');
      if (typeof Hls === 'undefined' || !Hls.isSupported()) {
        throw new Error('HLS.js không khởi tạo được');
      }
      if (sourceState.hlsInstance) { sourceState.hlsInstance.destroy(); }
      const hls = new Hls();
      sourceState.hlsInstance = hls;
      hls.loadSource(url);
      hls.attachMedia(webcam);
      hls.on(Hls.Events.ERROR, (e, data) => {
        if (data.fatal) addLog('violation', 'HLS ERR', data.details);
      });
    } catch (err) {
      addLog('violation', 'HLS ERR', err.message);
      alert('Lỗi HLS: ' + err.message);
      return;
    }
  }

  await new Promise((res) => {
    webcam.onloadedmetadata = res;
    webcam.onerror = () => res(); // Tiếp tục dù lỗi
    setTimeout(res, 5000); // Timeout fallback
  });
  webcam.play().catch(() => {});

  overlayCanvas.width  = state.canvasW = webcam.videoWidth  || 640;
  overlayCanvas.height = state.canvasH = webcam.videoHeight || 480;
  state.cameraOn = true;

  _onStreamConnected(url, 'HLS');
}

// Cập nhật UI sau khi stream kết nối
function _onStreamConnected(url, typeName) {
  const short = url.length > 38 ? url.slice(0, 35) + '...' : url;

  const badge = document.getElementById('sourceBadge');
  document.getElementById('sourceBadgeText').textContent = `${typeName} · ${short}`;
  badge.style.display = 'flex';
  document.getElementById('camBadgeText').textContent = 'STREAM · LIVE';

  sourceState.mode = 'stream';
  _updateSourceCurrentIndicator();
  addLog('ok', 'STREAM', `Đang phát: [${typeName}] ${url}`);

  if (state.detecting) startDetectionLoop();
  startFPSCounter();
  document.getElementById('sourceModal').style.display = 'none';
}

// ── DỌN DẸP NGUỒN HIỆN TẠI ────────────────────────────────────
function _teardownCurrentSource() {
  // Dừng webcam stream
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  webcam.srcObject = null;
  webcam.src = '';
  state.cameraOn = false;

  // Dừng HLS
  if (sourceState.hlsInstance) {
    sourceState.hlsInstance.destroy();
    sourceState.hlsInstance = null;
  }

  // Xóa img MJPEG nếu có
  const imgEl = document.getElementById('mjpegImg');
  if (imgEl) imgEl.style.display = 'none';
  state._mjpegImg = null;

  stopDetectionLoop();
  discardViolationRecording();
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  state.currentDetections = [];
}

// ── CẬP NHẬT CHỈ THỊ NGUỒN HIỆN TẠI ──────────────────────────
function _updateSourceCurrentIndicator() {
  const dot  = document.getElementById('sourceCurrentDot');
  const text = document.getElementById('sourceCurrentText');
  if (!dot || !text) return;

  if (!state.cameraOn) {
    dot.className = 'source-current-dot';
    text.textContent = 'Chưa kết nối nguồn nào';
  } else if (sourceState.mode === 'webcam') {
    dot.className = 'source-current-dot active';
    text.textContent = `Webcam · ${webcam.videoWidth}×${webcam.videoHeight}`;
  } else {
    dot.className = 'source-current-dot stream';
    const short = sourceState.streamUrl.length > 42
      ? sourceState.streamUrl.slice(0, 39) + '...'
      : sourceState.streamUrl;
    text.textContent = `[${sourceState.streamType.toUpperCase()}] ${short}`;
  }
}

// ── PATCH _detectFrame: hỗ trợ MJPEG img source ───────────────
// Ghi đè hàm _detectFrame gốc để vẽ từ mjpegImg thay vì webcam nếu cần
const _originalDetectFrame = _detectFrame;
// Hàm gốc vẫn dùng `webcam`, nhưng với MJPEG ta vẽ từ img
// → thay thế bằng cách monkey-patch nhẹ

// ── KẾT THÚC: Thêm "NGUỒN" vào status bar ─────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Thêm chỉ thị nguồn vào footer statusbar
  const sb = document.querySelector('.statusbar');
  if (sb) {
    const item = document.createElement('div');
    item.className = 'sb-item';
    item.id = 'sbSource';
    item.style.cssText = 'border-left:1px solid rgba(255,255,255,.07);padding-left:12px;';
    item.innerHTML = `<span class="sb-dot" id="sbSourceDot" style="background:#333"></span>Nguồn: <span id="sbSourceText">Chưa kết nối</span>`;
    sb.insertBefore(item, sb.lastElementChild);
  }
});

// Cập nhật statusbar khi nguồn thay đổi
const _origOnStreamConnected = _onStreamConnected;

// ── OVERRIDE startCamera để đồng bộ với sourceState ────────────
const _origStartCamera = startCamera;
async function startCamera() {
  await connectWebcam();
}

// ── KEYBOARD SHORTCUT: Escape đóng modal ──────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('sourceModal');
    if (modal?.style.display !== 'none') modal.style.display = 'none';
  }
});

// ── KHỞI ĐỘNG TỰ ĐỘNG ─────────────────────────────────────────

window.addEventListener('load', () => {
  addLog('ok', 'SYSTEM', 'CYBERVISION AI v3.1 khởi động — WebM recording + ZIP export');

  // Inject CSS badge-pulse
  const style = document.createElement('style');
  style.textContent = `
    #btnExportAll {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border: 1.5px solid var(--accent, #00ffb4);
      color: var(--accent, #00ffb4);
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      font-weight: 700;
      padding: 8px 14px;
      border-radius: 6px;
      cursor: pointer;
      letter-spacing: 0.5px;
      transition: background 0.2s, box-shadow 0.2s, opacity 0.2s;
    }
    #btnExportAll:not(:disabled):hover {
      background: linear-gradient(135deg, #0d2137 0%, #0a1628 100%);
      box-shadow: 0 0 12px rgba(0,255,180,0.25);
    }
    #btnClearAll {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: 1.5px solid #555;
      color: #888;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      font-weight: 600;
      padding: 7px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
    }
    #btnClearAll:hover {
      border-color: var(--red, #ff3b5c);
      color: var(--red, #ff3b5c);
    }
    #exportBadge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 5px;
      background: var(--red, #ff3b5c);
      color: #fff;
      font-size: 10px;
      font-weight: 800;
      border-radius: 10px;
      line-height: 1;
    }
    @keyframes badgePop {
      0%   { transform: scale(1); }
      40%  { transform: scale(1.5); }
      70%  { transform: scale(0.9); }
      100% { transform: scale(1); }
    }
    .badge-pulse { animation: badgePop 0.4s ease; }

    #exportToolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px 6px;
      border-bottom: 1px solid var(--border, #1e2a38);
      flex-wrap: wrap;
    }
    #exportToolbar .toolbar-title {
      flex: 1;
      font-size: 11px;
      font-weight: 700;
      color: #aaa;
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.5px;
    }
  `;
  document.head.appendChild(style);

  // Inject toolbar vào đầu snapGrid container
  const snapGrid = document.getElementById('snapGrid');
  if (snapGrid && snapGrid.parentElement) {
    const toolbar = document.createElement('div');
    toolbar.id = 'exportToolbar';
    toolbar.innerHTML = `
      <span class="toolbar-title">📁 VIDEO BẰNG CHỨNG</span>
      <button id="btnClearAll" onclick="clearAllViolations()" title="Xóa toàn bộ khỏi bộ nhớ">
        🗑 XÓA HẾT
      </button>
      <button id="btnExportAll" onclick="exportAllViolations()" disabled title="Tải toàn bộ video dạng ZIP">
        Thanh Dat & Xuan Do
        <span id="exportBadge">0</span>
      </button>
    `;
    snapGrid.parentElement.insertBefore(toolbar, snapGrid);
  }

  _updateExportBtn();
  setTimeout(startCamera, 800);
});