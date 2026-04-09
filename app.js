/**
 * XREAL 3D Cinema — app.js (v4)
 *
 * Chiến lược chuyển 3D (theo thứ tự ưu tiên):
 *   1. AUTO-DETECT màn hình: khi kính chuyển 3840×1080 sau khi nhấn nút vật lý → website
 *      tự động bật chế độ SBS ngay lập tức (không cần nhấn thêm gì)
 *   2. WebHID: thử gửi lệnh HID (bonus — có thể hoạt động với firmware cũ)
 *   3. Manual: nút 3D SBS trên website để người dùng chủ động toggle
 */

// ============================================================
// Utility
// ============================================================
let _toastTimer = null;
function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show${type ? ' toast-' + type : ''}`;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 3000);
}

// ============================================================
// Packet Builder — MCU Protocol (from ar-drivers-rs reverse engineering)
// ============================================================
const MCU = {
    VID: 0x3318,          // Xreal/Nreal Vendor ID (thực tế)
    PID_AIR2: 0x0428,     // Xreal Air 2 Product ID
    PID_AIR2PRO: 0x0432,  // Xreal Air 2 Pro Product ID
    PID_AIR: 0x0424,      // Xreal Air (gen 1) Product ID

    CMD_GET_MODE:  0x07,  // Lấy chế độ hiển thị hiện tại
    CMD_SET_MODE:  0x08,  // Đặt chế độ hiển thị
    MODE_2D:       0x01,  // Mirror / 2D
    MODE_3D:       0x03,  // SBS 3D 60Hz
    MODE_3D_72:    0x04,  // SBS 3D 72Hz
    MODE_HALF_SBS: 0x08,  // Half SBS

    /**
     * CRC32 Adler checksum — dùng trong MCU packet
     * Tính từ byte[5] tới byte[5 + length]
     */
    adler32(data) {
        let s1 = 1, s2 = 0;
        for (let i = 0; i < data.length; i++) {
            s1 = (s1 + data[i]) % 65521;
            s2 = (s2 + s1)      % 65521;
        }
        return (s2 << 16) | s1;
    },

    /**
     * Tạo MCU packet đúng định dạng:
     * [0]: 0xFD (head)
     * [1-4]: CRC32 Adler (little-endian)
     * [5-6]: length (little-endian) = data.length + 17
     * [7-10]: request_id = 0x1337 (little-endian)
     * [11-14]: timestamp = 0
     * [15-16]: cmd_id (little-endian)
     * [17-21]: reserved (5 bytes = 0)
     * [22-63]: data payload (max 42 bytes)
     */
    buildPacket(cmdId, payload = []) {
        const packet = new Uint8Array(0x40); // 64 bytes tổng
        const length = payload.length + 17;

        packet[0]  = 0xfd;                   // head
        // [1-4] checksum — điền sau
        packet[5]  = length & 0xff;          // length low
        packet[6]  = (length >> 8) & 0xff;   // length high
        packet[7]  = 0x37; packet[8] = 0x13; // request_id = 0x1337 LE
        packet[9]  = 0x00; packet[10] = 0x00;
        packet[11] = 0x00; packet[12] = 0x00; // timestamp = 0
        packet[13] = 0x00; packet[14] = 0x00;
        packet[15] = cmdId & 0xff;           // cmd_id low
        packet[16] = (cmdId >> 8) & 0xff;   // cmd_id high
        // [17-21] reserved = 0 (already 0)
        payload.forEach((b, i) => { packet[22 + i] = b; }); // data

        // Tính CRC32 Adler trên byte[5..(5+length)]
        const crcData = packet.slice(5, 5 + length);
        const crc = this.adler32(crcData);
        packet[1] = crc & 0xff;
        packet[2] = (crc >> 8)  & 0xff;
        packet[3] = (crc >> 16) & 0xff;
        packet[4] = (crc >> 24) & 0xff;

        return packet;
    },
};

// ============================================================
// Bridge Client — gọi Node.js HID bridge (giải pháp chắc chắn)
// ============================================================
const Bridge = {
    URL:         'http://localhost:8765',
    isAvailable: false,
    _lastCheck:  0,
    RECHECK_MS:  5000,

    async check() {
        const now = Date.now();
        if (now - this._lastCheck < this.RECHECK_MS) return this.isAvailable;
        this._lastCheck = now;
        try {
            const r = await fetch(`${this.URL}/status`, { signal: AbortSignal.timeout(800) });
            const j = await r.json();
            this.isAvailable = j.ok === true;
        } catch(_) {
            this.isAvailable = false;
        }
        this._updateBadge();
        return this.isAvailable;
    },

    async set3D(enable) {
        try {
            const r = await fetch(`${this.URL}/set3d?mode=${enable ? 1 : 0}`, {
                signal: AbortSignal.timeout(2000)
            });
            const j = await r.json();
            if (!j.ok) console.warn('⚠️ Bridge trả lỗi:', j.error);
            return j.ok === true;
        } catch(e) {
            console.warn('Bridge không phản hồi:', e.message);
            this.isAvailable = false;
            this._lastCheck  = 0; // force recheck next time
            this._updateBadge();
            return false;
        }
    },

    _updateBadge() {
        const el = document.getElementById('bridge-badge');
        if (!el) return;
        el.textContent   = this.isAvailable ? '🟢 Bridge' : '🔴 Bridge offline';
        el.title         = this.isAvailable
            ? 'Node.js HID Bridge đang chạy — có thể điều khiển kính'
            : 'Bridge chưa chạy. Mở terminal: npm run bridge';
        el.style.color       = this.isAvailable ? '#39ff14' : '#ff6b6b';
        el.style.borderColor = this.isAvailable ? 'rgba(57,255,20,0.3)' : 'rgba(255,107,107,0.3)';
    },
};

// ============================================================
// XrealController — HID connection + auto screen detection
// ============================================================
class XrealController {
    constructor(onGlasses3DChange) {
        this.devices          = [];
        this.glassesIs3D      = false; // trạng thái thực của kính (từ auto-detect màn hình)
        this.websiteIs3D      = false; // trạng thái web do người dùng chủ động toggle
        this.onGlasses3DChange = onGlasses3DChange; // callback khi kính thực sự thay đổi chế độ

        this.$badge     = document.getElementById('device-status');
        this.$statusTxt = document.getElementById('status-text');
        this.$resBadge  = document.getElementById('res-badge');
        this.$resText   = document.getElementById('res-text');
        this._lastRes   = { w: 0, h: 0 };

        this._initHID();
        this._startScreenWatch();
    }

    // ----------------------------------------------------------
    // HID — kết nối (chỉ để đọc state và thử gửi lệnh)
    // ----------------------------------------------------------
    _initHID() {
        if (!navigator.hid) {
            const btn = document.getElementById('btn-deep-scan');
            if (btn) { btn.disabled = true; btn.title = 'WebHID không khả dụng'; }
            return;
        }
        document.getElementById('btn-deep-scan').addEventListener('click', () => this.connectAll());
        navigator.hid.getDevices().then(devs => { if (devs.length) this._adopt(devs); });
        navigator.hid.addEventListener('connect',    ({ device }) => this._adopt([device]));
        navigator.hid.addEventListener('disconnect', ({ device }) => this._remove(device));
    }

    async connectAll() {
        try {
            const devs = await navigator.hid.requestDevice({ filters: [] });
            if (devs.length) {
                devs.forEach(d => console.log(
                    `📡 "${d.productName}" VID=0x${d.vendorId.toString(16)} PID=0x${d.productId.toString(16)} | collections: ${d.collections?.length}`
                ));
                await this._adopt(devs);
                showToast(`✅ Đã kết nối: ${devs[0].productName}`, 'success');
            }
        } catch(e) { /* user cancelled */ }
    }

    async _adopt(devs) {
        for (const dev of devs) {
            if (!dev.opened) {
                try { await dev.open(); } catch(e) { continue; }
            }
            if (!this.devices.includes(dev)) this.devices.push(dev);
        }
        this._updateBadge();
    }

    _remove(device) {
        this.devices = this.devices.filter(d => d !== device);
        this._updateBadge();
    }

    _updateBadge() {
        const ok = this.devices.length > 0;
        this.$badge.classList.toggle('connected', ok);
        this.$statusTxt.textContent = ok ? (this.devices[0].productName || 'Kính đã kết nối') : 'Chưa kết nối kính';
    }

    /**
     * Thử gửi lệnh HID (không spam log khi thất bại — là tình trạng bình thường
     * vì WebHID không truy cập được interface MCU của kính Air 2)
     */
    _trySend3DSilently(enable) {
        if (!this.devices.length) return;
        const mode   = enable ? MCU.MODE_3D : MCU.MODE_2D;
        const packet = MCU.buildPacket(MCU.CMD_SET_MODE, [mode]);
        for (const dev of this.devices) {
            dev.sendReport(0x00, packet).catch(() => {}); // silent fail — expected
        }
    }

    // ----------------------------------------------------------
    // ★ AUTO SCREEN WATCH — Phát hiện kính chuyển 3840×1080
    // ----------------------------------------------------------
    _startScreenWatch() {
        let lastDetected = null; // debounce: chỉ fire khi phát hiện 2 lần liên tiếp

        const check = () => {
            const w = window.screen.width;
            const h = window.screen.height;

            // Cập nhật badge độ phân giải (luôn cập nhật kể cả không thay đổi chế độ)
            const key = `${w}×${h}`;
            if (key !== this._lastRes.key) {
                this._lastRes = { w, h, key };
                this._updateResBadge(w, h);
            }

            // Kính Air 2 ở chế độ 3D: 3840×1080
            const detected3D = (w >= 3800 && h <= 1110);

            // Debounce: chỉ xử lý khi phát hiện trạng thái nhất quán qua 2 lần check
            if (detected3D !== lastDetected) {
                lastDetected = detected3D;
                return; // Chờ lần check tiếp theo để xác nhận
            }

            // Xác nhận thay đổi thực sự (debounce passed)
            if (detected3D !== this.glassesIs3D) {
                this.glassesIs3D = detected3D;
                console.log(`🥽 Kính thay đổi: ${detected3D ? '3D (3840×1080)' : '2D'}`);
                this.onGlasses3DChange(detected3D);
                showToast(
                    detected3D ? '🥽 Kính chuyển 3D — SBS đã bật tự động!' : '🖥️ Kính về 2D',
                    detected3D ? 'success' : ''
                );
            }
        };

        window.addEventListener('resize', () => { lastDetected = null; check(); });
        setInterval(check, 1000);
        check();
    }

    _updateResBadge(w, h) {
        const is3D = w >= 3800;
        if (!this.$resText) return;
        this.$resText.textContent = `${is3D ? '🟢' : '⬜'} ${w}×${h}`;
        if (this.$resBadge) {
            this.$resBadge.style.borderColor = is3D ? 'rgba(0,242,255,0.4)' : '';
            this.$resBadge.style.color       = is3D ? '#00f2ff' : '';
        }
    }

    // ----------------------------------------------------------
    // Toggle từ nút thủ công — thử bridge trước, fallback WebHID
    // ----------------------------------------------------------
    async manualToggle3D() {
        const target = !this.websiteIs3D;
        this.websiteIs3D = target;

        // ① Thử bridge (Node.js native HID — chắc chắn nhất)
        const bridgeOk = await Bridge.check();
        if (bridgeOk) {
            const sent = await Bridge.set3D(target);
            if (sent) {
                console.log(`🟢 Bridge: đã gửi lệnh ${target ? '3D' : '2D'}`);
                return target;
            }
        }

        // ② Fallback: WebHID (có thể thất bại do OS permission)
        this._trySend3DSilently(target);
        if (!bridgeOk) {
            showToast('⚠️ Bridge chưa chạy. Chạy: npm run bridge', 'warn');
        }
        return target;
    }
}

// ============================================================
// Depth Map Engine (Removed, using inline fast algorithm)
// ============================================================

// ============================================================
// SBS Converter (2D → 3D)
// ============================================================
class SBSConverter {
    constructor() {
        this.canvas = document.getElementById('sbs-canvas');
        this.ctx    = this.canvas.getContext('2d', { willReadFrequently: true });
        this.canvas.width  = 2560;
        this.canvas.height = 720;

        this.offscreen = document.createElement('canvas');
        this.offscreen.width  = 1280;
        this.offscreen.height = 720;
        this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true });

        this.imgEl  = new Image();
        this.vidEl  = document.createElement('video');
        this.vidEl.muted = false; this.vidEl.loop = true; this.vidEl.playsInline = true;

        this.$prevVideo = document.getElementById('preview-video');
        this.$prevImg   = document.getElementById('preview-image');

        this.sourceType = 'none';
        this.loaded     = false;
        this.baseFit    = 1;
        this.sbsActive  = false;
        this._looping   = false;
        this.pan = { x: 0, y: 0, dragging: false, lx: 0, ly: 0 };

        this.$depth  = document.getElementById('sl-depth');
        this.$zoom   = document.getElementById('sl-zoom');
        this.$h      = document.getElementById('sl-h');
        this.$v      = document.getElementById('sl-v');
        this.$invert = document.getElementById('cb-invert');

        this._initEvents();
    }

    _initEvents() {
        [this.$depth, this.$zoom, this.$h, this.$v].forEach(sl =>
            sl.addEventListener('input', () => { this._updateLabels(); this._drawSBS(); })
        );
        this.$invert.addEventListener('change', () => this._drawSBS());

        const wrap = document.getElementById('canvas-wrap');
        wrap.addEventListener('mousedown', e => { this.pan.dragging=true; this.pan.lx=e.clientX; this.pan.ly=e.clientY; });
        window.addEventListener('mousemove', e => {
            if (!this.pan.dragging) return;
            this.pan.x += e.clientX - this.pan.lx; this.pan.lx = e.clientX;
            this.pan.y += e.clientY - this.pan.ly; this.pan.ly = e.clientY;
            this._drawSBS();
        });
        window.addEventListener('mouseup', () => { this.pan.dragging = false; });

        document.getElementById('play-overlay').addEventListener('click', () => this._togglePlay());
        document.getElementById('btn-download-sbs').addEventListener('click', () => {
            const a = document.createElement('a'); a.download = 'sbs_3d.png';
            a.href = this.canvas.toDataURL('image/png'); a.click();
        });
        document.getElementById('btn-reset-view').addEventListener('click', () => this.reset());
        document.getElementById('btn-toggle-panel').addEventListener('click', () =>
            document.getElementById('controls-panel').classList.toggle('hidden')
        );
    }

    _updateLabels() {
        document.getElementById('val-depth').textContent = this.$depth.value;
        document.getElementById('val-zoom').textContent  = parseFloat(this.$zoom.value).toFixed(2);
        document.getElementById('val-h').textContent     = this.$h.value;
        document.getElementById('val-v').textContent     = this.$v.value;

        // Nếu có bản sao UI (đang bật SBS), đồng bộ dữ liệu hiển thị (kể cả slider thumb)
        if (this.sbsActive) {
            const cloneD = document.getElementById('val-depth-clone');
            if (cloneD) {
                cloneD.textContent = this.$depth.value;
                document.getElementById('val-zoom-clone').textContent = parseFloat(this.$zoom.value).toFixed(2);
                document.getElementById('val-h-clone').textContent = this.$h.value;
                document.getElementById('val-v-clone').textContent = this.$v.value;
                
                // Đồng bộ giá trị của <input type="range"> (cho visual thumb)
                document.getElementById('sl-depth-clone').value = this.$depth.value;
                document.getElementById('sl-zoom-clone').value = this.$zoom.value;
                document.getElementById('sl-h-clone').value = this.$h.value;
                document.getElementById('sl-v-clone').value = this.$v.value;
                document.getElementById('cb-invert-clone').checked = this.$invert.checked;
            }
        }
    }

    _getFit(srcW, srcH) {
        const scale = this.baseFit * parseFloat(this.$zoom.value);
        const dw = srcW * scale, dh = srcH * scale;
        return {
            x: (1280-dw)/2 + this.pan.x + parseInt(this.$h.value),
            y: (720 -dh)/2 + this.pan.y + parseInt(this.$v.value),
            dw, dh,
        };
    }

    reset() {
        this.$zoom.value='1'; this.$h.value='0'; this.$v.value='0'; this.$depth.value='30';
        this.pan = { x:0, y:0, dragging:false, lx:0, ly:0 };
        this._updateLabels();
        if (this.sbsActive) this._drawSBS();
    }

    loadImage(file) {
        this.sourceType = 'image';
        const reader = new FileReader();
        reader.onload = ev => {
            this.imgEl.onload = () => {
                this.baseFit = Math.min(1280/this.imgEl.width, 720/this.imgEl.height);
                this.loaded  = true;
                this.$prevImg.src = ev.target.result;
                this.$prevImg.classList.remove('hidden');
                this.$prevVideo.classList.add('hidden');
                document.getElementById('btn-download-sbs').style.display = '';
            };
            this.imgEl.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    }

    loadVideo(file) {
        this.sourceType = 'video';
        const url = URL.createObjectURL(file);
        this.vidEl.src = url;
        this.$prevVideo.src = url;
        this.$prevVideo.classList.remove('hidden');
        this.$prevImg.classList.add('hidden');
        this.vidEl.onloadedmetadata = () => {
            this.baseFit = Math.min(1280/this.vidEl.videoWidth, 720/this.vidEl.videoHeight);
            this.loaded  = true;
            document.getElementById('btn-download-sbs').style.display = 'none';
        };
    }

    setSBSMode(active) {
        this.sbsActive = active;
        document.body.classList.toggle('sbs-active', active);
        document.getElementById('preview-layer').classList.toggle('hidden',  active);
        document.getElementById('canvas-wrap').classList.toggle('hidden',   !active);
        
        const cPanel = document.getElementById('controls-panel');
        let clone = document.getElementById('controls-panel-clone');

        if (active) {
            // Hiển thị panel và chuẩn bị clone cho chế độ SBS
            cPanel.classList.remove('hidden');
            
            if (!clone) {
                clone = cPanel.cloneNode(true);
                clone.id = 'controls-panel-clone';
                clone.style.pointerEvents = 'none'; // Chỉ để nhìn, không click được
                // Cập nhật lại ID trong clone để không bị trùng (và dễ lấy)
                clone.querySelectorAll('[id]').forEach(el => {
                    el.id = el.id + '-clone';
                });
                cPanel.parentNode.appendChild(clone);
            }
            clone.classList.remove('hidden');
            this._updateLabels(); // Đồng bộ dữ liệu sang clone

            if (this.loaded) {
                if (this.sourceType === 'video') {
                    document.getElementById('play-overlay').style.display = 'flex';
                } else {
                    this._drawSBS();
                }
            }
        } else {
            // Tắt chế độ SBS
            cPanel.classList.remove('hidden'); // Trong màn hình Native 2D vẫn hiện control (hoặc ẩn tuỳ thiết kế, ở đây tạm ẩn)
            if (clone) clone.classList.add('hidden');
            
            this._looping = false;
            if (this.vidEl) this.vidEl.pause();
        }
    }

    _togglePlay() {
        const overlay = document.getElementById('play-overlay');
        if (this.vidEl.paused) {
            this.vidEl.play(); this.$prevVideo.play();
            overlay.style.display = 'none';
            this._looping = true; this._videoLoop();
        } else {
            this.vidEl.pause(); this.$prevVideo.pause();
            overlay.style.display = 'flex';
            this._looping = false;
        }
    }

    _videoLoop() {
        if (!this._looping || !this.sbsActive) return;
        if (this.vidEl.readyState >= 2) this._drawSBS();
        requestAnimationFrame(() => this._videoLoop());
    }

    _drawSBS() {
        if (!this.loaded) return;
        const source = this.sourceType === 'image' ? this.imgEl : this.vidEl;
        const srcW   = this.sourceType === 'image' ? this.imgEl.width  : this.vidEl.videoWidth;
        const srcH   = this.sourceType === 'image' ? this.imgEl.height : this.vidEl.videoHeight;
        if (!srcW || !srcH) return;

        const fit = this._getFit(srcW, srcH);

        this.ctx.clearRect(0, 0, 2560, 720);
        this.ctx.drawImage(source, fit.x, fit.y, fit.dw, fit.dh);

        const leftData = this.ctx.getImageData(0, 0, 1280, 720);
        const out      = this.ctx.createImageData(1280, 720);

        const depth  = parseInt(this.$depth.value);
        const invert = this.$invert.checked;

        for (let y = 0; y < 720; y++) {
            for (let x = 0; x < 1280; x++) {
                let dx = (x - 640) / 640;
                let z  = 1 - Math.abs(dx);
                if (invert) z = 1 - z;
                let shift = z * depth;
                let sx = Math.max(0, x - shift);
                let si = (y * 1280 + Math.floor(sx)) * 4;
                let i  = (y * 1280 + x) * 4;

                out.data[i]     = leftData.data[si];
                out.data[i + 1] = leftData.data[si + 1];
                out.data[i + 2] = leftData.data[si + 2];
                out.data[i + 3] = 255;
            }
        }

        this.ctx.putImageData(out, 1280, 0);
    }
}

// ============================================================
// App Controller
// ============================================================
class App {
    constructor() {
        // XrealController nhận callback → được gọi khi phát hiện độ phân giải thay đổi
        this.xreal = new XrealController((is3D) => {
            this._apply3DMode(is3D);
        });

        this.converter = new SBSConverter();
        this.$splash   = document.getElementById('splash-screen');
        this.$viewport = document.getElementById('media-viewport');
        this.$nativeV  = document.getElementById('native-view');
        this.$convertV = document.getElementById('convert-view');
        this.$video    = document.getElementById('main-video');
        this.$image    = document.getElementById('main-image');
        this.mode = null;

        this._initEvents();
    }

    _initEvents() {
        document.getElementById('file-native').addEventListener('change', e => {
            const f = e.target.files[0]; if (f) this._openNative(f);
        });
        document.getElementById('media-upload').addEventListener('change', e => {
            const f = e.target.files[0]; 
            if (f) {
                const type = f.type.startsWith('video/') ? 'video' : 'image';
                this._openConvert(f, type);
            }
        });

        // ★ Nút toggle 3D thủ công (luôn hiển thị góc trên phải)
        document.getElementById('btn-toggle-3d').addEventListener('click', async () => {
            const is3D = await this.xreal.manualToggle3D();
            this._apply3DMode(is3D);
            showToast(is3D ? '🥽 Layout 3D SBS đã bật' : '🖥️ Layout 2D', is3D ? 'success' : '');
        });

        // ★ Fullscreen (luôn hiển thị góc trên phải)
        document.getElementById('btn-fullscreen').addEventListener('click', () => this._toggleFS());
        document.getElementById('btn-back').addEventListener('click', () => this._goBack());

        document.addEventListener('keydown', e => {
            if (this.$viewport.classList.contains('hidden')) return;
            const k = e.key.toLowerCase();
            if (k === 'f')       this._toggleFS();
            if (k === 'w')       document.getElementById('btn-toggle-3d').click();
            if (k === 'escape' && !document.fullscreenElement) this._goBack();
            if (k === ' ') {
                e.preventDefault();
                if (this.mode === 'native')  { this.$video.paused ? this.$video.play() : this.$video.pause(); }
                if (this.mode === 'convert') { this.converter._togglePlay(); }
            }
        });

        document.addEventListener('fullscreenchange', () => {
            const fs = !!document.fullscreenElement;
            document.getElementById('fs-label').textContent = fs ? '⊡ Thu nhỏ' : '⛶ Full';
        });

        // Drag & drop
        document.getElementById('splash-screen').addEventListener('dragover', e => e.preventDefault());
        document.getElementById('splash-screen').addEventListener('drop', e => {
            e.preventDefault();
            const f = e.dataTransfer.files[0]; if (!f) return;
            const name = f.name.toLowerCase();
            (name.includes('sbs') || name.includes('3d') || name.includes('hsbs'))
                ? this._openNative(f)
                : this._openConvert(f, f.type.startsWith('image/') ? 'image' : 'video');
        });
    }

    _openNative(file) {
        this.mode = 'native';
        const url  = URL.createObjectURL(file);
        const isImg = file.type.startsWith('image/');
        this._showViewer('native');
        this.$image.src = isImg ? url : ''; this.$video.src = isImg ? '' : url;
        this.$image.classList.toggle('hidden',  !isImg);
        this.$video.classList.toggle('hidden',  isImg);
        if (!isImg) this.$video.play();
        // Không reset mode — khởi đầu với layout phù hợp trạng thái hiện tại
        const currentIs3D = this.xreal.glassesIs3D || this.xreal.websiteIs3D;
        this._apply3DMode(currentIs3D);
        showToast(`📂 ${file.name}`);
    }

    _openConvert(file, type) {
        this.mode = 'convert';
        this._showViewer('convert');
        type === 'image' ? this.converter.loadImage(file) : this.converter.loadVideo(file);
        const currentIs3D = this.xreal.glassesIs3D || this.xreal.websiteIs3D;
        this.converter.setSBSMode(currentIs3D);
        this._apply3DMode(currentIs3D);
        showToast(`✨ ${file.name}`);
    }

    _showViewer(mode) {
        this.$splash.classList.add('hidden');
        this.$viewport.classList.remove('hidden');
        this.$nativeV.classList.toggle('hidden',  mode !== 'native');
        this.$convertV.classList.toggle('hidden', mode !== 'convert');
    }

    _apply3DMode(is3D) {
        [this.$video, this.$image].forEach(el => el.classList.toggle('sbs-mode', is3D));
        document.getElementById('sbs-canvas').classList.toggle('sbs-mode', is3D);
        if (this.mode === 'convert') this.converter.setSBSMode(is3D);
        document.getElementById('btn-toggle-3d').classList.toggle('active-3d', is3D);
        document.getElementById('mode-label').textContent = is3D ? '🥽 3D SBS' : '🖥️ 2D';
    }

    _toggleFS() {
        if (!document.fullscreenElement) {
            this.$viewport.requestFullscreen().catch(() => document.documentElement.requestFullscreen());
        } else {
            document.exitFullscreen();
        }
    }

    _goBack() {
        if (document.fullscreenElement) document.exitFullscreen();
        this.$viewport.classList.add('hidden');
        this.$splash.classList.remove('hidden');
        this.$video.pause(); this.$video.src = '';
        this.$image.src = '';
        this.converter.vidEl.pause(); this.converter._looping = false;
        this.converter.loaded = false;
        this.converter.setSBSMode(false);
        // Giữ trạng thái 3D của kính (không tắt)
        this.mode = null;
        ['file-native','file-img-2d','file-vid-2d'].forEach(id => { document.getElementById(id).value = ''; });
    }
}

// ============================================================
// Boot
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    window._app = new App();
    console.log(`🎬 XREAL 3D Cinema v4 | Màn hình: ${window.screen.width}×${window.screen.height}`);
    // Kiểm tra bridge ngay lập tức và mỗi 5 giây
    Bridge.check();
    setInterval(() => Bridge.check(), 5000);
});
