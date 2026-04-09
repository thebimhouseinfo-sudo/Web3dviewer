const HID = require('node-hid');

try {
    const devices = HID.devices().filter(d => 
        (d.vendorId === 0x3318 && d.interface === 4)
    );

    if (!devices.length) {
        console.log("❌ Không tìm thấy giao diện MCU của kính XREAL.");
        process.exit(1);
    }

    const devicePath = devices[0].path;
    console.log("✅ Đã tìm thấy MCU Interface 4 tại:", devicePath);

    const dev = new HID.HID(devicePath);
    console.log("🎧 BẮT ĐẦU NGHE... Xin hãy NHẤN GIỮ NÚT TRÊN KÍNH ĐỂ CHUYỂN 3D!!!");
    console.log("===============================================================");

    dev.on("data", (data) => {
        // In ra gói data nhận được dưới dạng hex
        const hex = data.toString('hex').match(/.{1,2}/g).join(' ');
        
        // Cố gắng parse nội dung XREAL Packet Header (0xFD) - Lưu ý: node-hid có thể trả về array 64 hoặc 65 byte.
        let offset = data[0] === 0x00 ? 1 : 0; // Kể cả báo cáo không có report ID, node-hid Windows có thể trả về 0x00 đầu
        
        let head = data[offset];
        if (head === 0xfd || head === 0xaa) {
            console.log(`[PACKET ${head === 0xfd ? 'MCU' : 'IMU'}] Dài: ${data.length} bytes`);
            console.log("Raw HEX:", hex);
            
            if (head === 0xfd && data.length >= offset + 17) {
                let cmd = data.readUInt16LE(offset + 15);
                console.log(`=> LỆNH (CMD_ID): 0x${cmd.toString(16).padStart(4, '0')}`);
                let bodyLen = data.readUInt16LE(offset + 5) - 17;
                if (bodyLen > 0) {
                    let bodyStr = data.slice(offset + 22, offset + 22 + bodyLen).toString('hex').match(/.{1,2}/g).join(' ');
                    console.log(`=> PAYLOAD: ${bodyStr}`);
                }
            }
            console.log("------------------------------------------");
        }
    });

    dev.on("error", (err) => {
        console.error("Lỗi đọc HID:", err);
    });

} catch (err) {
    console.error("Lỗi:", err);
}
