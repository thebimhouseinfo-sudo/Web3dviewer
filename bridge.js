#!/usr/bin/env node
/**
 * XREAL HID Bridge — bridge.js
 *
 * Chạy: node bridge.js
 * Cần cài trước: npm install node-hid
 *
 * Bridge này mở trực tiếp MCU interface (interface 4) của kính XREAL Air 2
 * và nhận lệnh từ website qua HTTP tại http://localhost:8765
 *
 * Dựa trên reverse engineering từ ar-drivers-rs (badicsalex/ar-drivers-rs)
 * Protocol: MCU packet với header 0xFD + CRC32 Adler
 */

'use strict';

const http  = require('http');
const PORT  = 8765;

// ---- Kiểm tra node-hid ----
let HID;
try {
    HID = require('node-hid');
} catch(e) {
    console.error('\n❌ node-hid chưa được cài đặt!');
    console.error('   Chạy lệnh sau rồi thử lại:\n');
    console.error('   npm install node-hid\n');
    process.exit(1);
}

// ---- Constants ----
const XREAL_VID     = 0x3318; // Xreal/Nreal Vendor ID
const XREAL_PID_AIR2 = 0x0428; // XREAL Air 2 Product ID
const MCU_IFACE     = 4;      // MCU command interface (từ ar-drivers-rs)

const CMD_SET_MODE  = 0x08;
const MODE_2D       = 0x01;   // Mirror / SameOnBoth
const MODE_3D_SBS   = 0x03;   // 3D Side-by-Side 60Hz
const MODE_3D_72HZ  = 0x04;   // 3D SBS 72Hz

// ---- MCU Packet Builder ----
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Tạo MCU packet 64 bytes:
 * [0]    : 0xFD (head)
 * [1-4]  : CRC32 LE
 * [5-6]  : length LE = payload.length + 17
 * [7-10] : request_id = 0x1337 LE
 * [11-14]: timestamp = 0
 * [15-16]: cmd_id LE
 * [17-21]: reserved
 * [22+]  : payload
 */
function buildMCUPacket(cmdId, payload = []) {
    const packet = Buffer.alloc(64, 0);
    const length = payload.length + 17;

    packet[0]  = 0xfd;
    packet[5]  = length & 0xff;
    packet[6]  = (length >> 8) & 0xff;
    packet[7]  = 0x37; packet[8] = 0x13; // 0x1337 LE
    // timestamp = 0 (already 0)
    packet[15] = cmdId & 0xff;
    packet[16] = (cmdId >> 8) & 0xff;
    // reserved [17-21] = 0
    payload.forEach((b, i) => { packet[22 + i] = b; });

    // CRC32 trên [5..(5+length)]
    const crc = crc32(packet.slice(5, 5 + length));
    packet.writeUInt32LE(crc, 1);

    return packet;
}

// ---- Device Management ----
let mcuDevice   = null;
let deviceInfo  = null;
let lastError   = null;

function listXrealInterfaces() {
    try {
        return HID.devices(XREAL_VID, XREAL_PID_AIR2);
    } catch(e) {
        return HID.devices().filter(d => d.vendorId === XREAL_VID);
    }
}

function openMCUDevice() {
    const allIfaces = listXrealInterfaces();

    console.log(`\n📡 Tìm thấy ${allIfaces.length} HID interface XREAL:`);
    allIfaces.forEach(d => {
        console.log(`   Interface ${d.interface}  usage=0x${d.usage?.toString(16)?.padStart(4,'0')}  page=0x${d.usagePage?.toString(16)?.padStart(4,'0')}  "${d.product || d.manufacturer || '?'}"  [${d.path}]`);
    });

    // Ưu tiên: interface MCU_IFACE (=4) → nếu không có thì thử tất cả
    let target = allIfaces.find(d => d.interface === MCU_IFACE);

    if (!target) {
        console.warn(`⚠️ Không tìm thấy interface ${MCU_IFACE}. Thử tất cả interfaces...`);
        // Thử lần lượt từng interface
        for (const iface of allIfaces) {
            try {
                const dev = new HID.HID(iface.path);
                const pkt = buildMCUPacket(0x07, []); // CMD_GET_MODE: test read
                dev.write([0x00, ...pkt]);
                console.log(`✅ Interface ${iface.interface} có thể ghi!`);
                deviceInfo = iface;
                return dev;
            } catch(_) {}
        }
        lastError = `Không tìm thấy interface khả dụng (cần interface ${MCU_IFACE})`;
        return null;
    }

    try {
        const dev = new HID.HID(target.path);
        deviceInfo = target;
        lastError  = null;
        console.log(`✅ Mở MCU interface ${target.interface} thành công!`);
        return dev;
    } catch(e) {
        lastError = e.message;
        console.error(`❌ Không mở được interface ${target.interface}: ${e.message}`);
        if (e.message.toLowerCase().includes('access') || e.message.toLowerCase().includes('permission')) {
            console.error('   → Hãy đảm bảo đã đóng Nebula và các app XREAL khác');
        }
        return null;
    }
}

function ensureDevice() {
    if (!mcuDevice) mcuDevice = openMCUDevice();
    return mcuDevice;
}

function sendMode3D(enable) {
    const dev = ensureDevice();
    if (!dev) return { ok: false, error: lastError || 'Không tìm thấy kính' };

    const mode   = enable ? MODE_3D_SBS : MODE_2D;
    const packet = buildMCUPacket(CMD_SET_MODE, [mode]);

    try {
        // TRỌNG TÂM: Trên Windows, nếu device không dùng Report ID, `node-hid` sẽ 
        // coi byte đầu tiên là Report ID và CẮT BỎ nó. Do đó nếu ta gửi thẳng packet (byte 0 = 0xFD), 
        // hệ thống sẽ cắt mất chữ ký 0xFD và gửi chắp vá 63 bytes còn lại.
        // Giải pháp: Prepend 0x00 để Windows cắt 0x00, giữ nguyên vẹn 64 bytes packet.
        const writeBuf = [0x00, ...packet];
        mcuDevice.write(writeBuf);
        console.log(`✅ Lệnh ${enable ? '3D SBS (mode=0x03)' : '2D (mode=0x01)'} gửi thành công`);
        return { ok: true, mode: enable ? '3D' : '2D' };
    } catch(e) {
        console.error(`❌ Gửi lệnh thất bại: ${e.message}`);
        mcuDevice = null;
        lastError = e.message;
        return { ok: false, error: e.message };
    }
}

// ---- HTTP Server ----
const server = http.createServer((req, res) => {
    // CORS — cho phép website localhost gọi bridge
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    const url   = new URL(req.url, `http://localhost:${PORT}`);
    const path  = url.pathname;

    // GET /status — kiểm tra bridge và thiết bị
    if (path === '/status') {
        const dev = ensureDevice();
        res.writeHead(200);
        res.end(JSON.stringify({
            ok:          true,
            bridge:      'running',
            deviceFound: !!dev,
            deviceInfo:  deviceInfo ? {
                interface:  deviceInfo.interface,
                product:    deviceInfo.product,
                path:       deviceInfo.path,
            } : null,
            error: lastError,
        }));
        return;
    }

    // GET /set3d?mode=1 (3D) hoặc ?mode=0 (2D)
    if (path === '/set3d') {
        const modeParam = url.searchParams.get('mode');
        const enable    = modeParam === '1' || modeParam === 'true' || modeParam === '3d';
        const result    = sendMode3D(enable);
        res.writeHead(result.ok ? 200 : 500);
        res.end(JSON.stringify(result));
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Unknown endpoint. Use /status or /set3d?mode=0|1' }));
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} đã được dùng. Bridge có thể đang chạy rồi.`);
    } else {
        console.error('Server error:', e.message);
    }
    process.exit(1);
});

// Xử lý graceful shutdown
process.on('SIGINT',  () => { console.log('\n👋 Bridge đã dừng.'); mcuDevice?.close?.(); process.exit(0); });
process.on('SIGTERM', () => { mcuDevice?.close?.(); process.exit(0); });

// ---- Start ----
server.listen(PORT, '127.0.0.1', () => {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║      XREAL HID Bridge — đang chạy           ║');
    console.log(`║   http://localhost:${PORT}                    ║`);
    console.log('╠══════════════════════════════════════════════╣');
    console.log('║  Endpoints:                                  ║');
    console.log(`║   GET /status          — kiểm tra kết nối   ║`);
    console.log(`║   GET /set3d?mode=1    — bật 3D SBS         ║`);
    console.log(`║   GET /set3d?mode=0    — về 2D              ║`);
    console.log('╚══════════════════════════════════════════════╝');

    mcuDevice = openMCUDevice();

    if (!mcuDevice) {
        console.warn('\n⚠️  Chưa tìm thấy kính. Đảm bảo:');
        console.warn('   1. Kính đang cắm USB bình thường');
        console.warn('   2. Đã đóng Nebula / XREAL Hub');
        console.warn('   3. Chờ vài giây rồi nhấn [Kết nối kính] trên web\n');
    } else {
        console.log('\n🥽 Kính đã sẵn sàng! Mở website và nhấn nút 3D SBS.\n');
    }
});
