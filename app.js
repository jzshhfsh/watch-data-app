// ==================== 常量定义 ====================
const SERVICE_UUID = '000018ac-0000-1000-8000-00805f9b34fb';
const NOTIFY_CHAR_UUID = '00002aac-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR_UUID = '00002aad-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_CHAR_UUID = '00002a19-0000-1000-8000-00805f9b34fb';

// 尝试不同的命令（根据你的抓包选择）
// 命令1: 步数同步（推测）
const ACTIVATION_CMD = new Uint8Array([0xDF, 0x00, 0x05, 0x15, 0x27, 0x04, 0x06, 0x00, 0x00]);
// 命令2: 原始心率激活（可能也有效）
// const ACTIVATION_CMD = new Uint8Array([0xDF, 0x00, 0x06, 0xEF, 0x02, 0x04, 0x02, 0x00, 0x01, 0x01]);

// ==================== 全局变量 ====================
let gattServer = null;
let notifyCharacteristic = null;
let writeCharacteristic = null;
let firstPacket = null;
let keepAliveInterval = null;
let db = null;

// IndexedDB 配置
const DB_NAME = 'SportsDataDB';
const DB_VERSION = 1;
const STORE_NAME = 'dailyStats';

// ==================== 工具函数 ====================
function buf2hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join(' ');
}

function updateUI(steps, distance, calorie) {
    document.getElementById('steps').innerText = steps;
    document.getElementById('distance').innerText = distance;
    document.getElementById('calories').innerText = (calorie / 100).toFixed(2);
}

function setStatus(message, isError = false) {
    const statusDiv = document.getElementById('statusArea');
    statusDiv.innerHTML = message;
    statusDiv.style.color = isError ? '#ff3b30' : '#666';
}

function showError(message) {
    document.getElementById('errorArea').innerHTML = `<p>❌ ${message}</p>`;
    setStatus(message, true);
}

function clearError() {
    document.getElementById('errorArea').innerHTML = '';
}

// ==================== IndexedDB 操作 ====================
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => reject(event.target.error);
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('IndexedDB opened');
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'date' });
            }
        };
    });
}

function saveDataToDB(steps, distance, calories) {
    if (!db) return;
    const today = new Date().toISOString().slice(0, 10);
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put({ date: today, steps, distance, calories });
}

function loadTodayData() {
    if (!db) return;
    const today = new Date().toISOString().slice(0, 10);
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(today);
    request.onsuccess = () => {
        if (request.result) {
            const { steps, distance, calories } = request.result;
            updateUI(steps, distance, calories);
        }
    };
}

// ==================== 保活机制 ====================
async function keepAlive() {
    if (!gattServer?.connected) return;
    try {
        const service = await gattServer.getPrimaryService(BATTERY_SERVICE_UUID);
        const char = await service.getCharacteristic(BATTERY_CHAR_UUID);
        const value = await char.readValue();
        const batteryLevel = value.getUint8(0);
        console.log(`保活 - 电量: ${batteryLevel}%`);
        setStatus(`连接正常，电量 ${batteryLevel}%`);
    } catch (e) {
        console.warn('保活失败，可能已断开', e);
        stopKeepAlive();
        setStatus('连接已断开', true);
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('dataArea').style.display = 'none';
    }
}

function startKeepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(keepAlive, 30000);
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// ==================== 通知处理 ====================
function handleNotifications(event) {
    const data = new Uint8Array(event.target.value);
    console.log(`收到通知 长度${data.length}: ${buf2hex(data)}`);

    if (data.length === 20 && data[0] === 0xDF) {
        firstPacket = data;
        console.log('暂存第一条包');
    } else if (data.length === 1 && firstPacket !== null) {
        const steps = (firstPacket[9] << 24) | (firstPacket[10] << 16) | (firstPacket[11] << 8) | firstPacket[12];
        const distance = (firstPacket[13] << 24) | (firstPacket[14] << 16) | (firstPacket[15] << 8) | firstPacket[16];
        const calorie = (firstPacket[17] << 24) | (firstPacket[18] << 16) | (firstPacket[19] << 8) | data[0];
        console.log(`步数=${steps}, 距离=${distance}, 卡路里=${calorie}`);
        updateUI(steps, distance, calorie);
        saveDataToDB(steps, distance, calorie);
        firstPacket = null;
    } else {
        if (firstPacket !== null) {
            console.warn('收到意外包，重置状态');
            firstPacket = null;
        }
    }
}

// ==================== 蓝牙连接 ====================
async function connectToDevice() {
    if (!navigator.bluetooth) {
        showError('当前浏览器不支持 Web Bluetooth API。请使用 Android Chrome 并确保 HTTPS 访问。');
        return;
    }

    if (gattServer?.connected) {
        try { await gattServer.disconnect(); } catch(e) {}
    }
    stopKeepAlive();
    firstPacket = null;

    try {
        setStatus('正在请求设备...');
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'S10Pro' }],  // 请根据你的手表实际名称修改
            optionalServices: [SERVICE_UUID, BATTERY_SERVICE_UUID]
        });

        setStatus('正在连接...');
        gattServer = await device.gatt.connect();
        console.log('GATT连接成功');

        setStatus('正在获取服务...');
        const service = await gattServer.getPrimaryService(SERVICE_UUID);
        console.log('服务获取成功');

        notifyCharacteristic = await service.getCharacteristic(NOTIFY_CHAR_UUID);
        writeCharacteristic = await service.getCharacteristic(WRITE_CHAR_UUID);
        console.log('特征获取成功');

        // 订阅通知
        await notifyCharacteristic.startNotifications();
        notifyCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);
        console.log('通知订阅成功');

        // 发送激活命令（使用无响应写入）
        await writeCharacteristic.writeValueWithoutResponse(ACTIVATION_CMD);
        console.log('激活命令已发送');

        startKeepAlive();

        document.getElementById('connectBtn').disabled = true;
        document.getElementById('dataArea').style.display = 'block';
        clearError();
        setStatus('已连接，等待数据...');

        loadTodayData();
    } catch (error) {
        console.error('连接错误:', error);
        showError(error.message);
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('dataArea').style.display = 'none';
        if (gattServer?.connected) await gattServer.disconnect();
        stopKeepAlive();
    }
}

// ==================== 页面卸载清理 ====================
window.addEventListener('beforeunload', () => {
    stopKeepAlive();
    if (gattServer?.connected) gattServer.disconnect();
});

// ==================== Service Worker 注册（可选）====================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW注册失败', err));
    });
}

// ==================== 初始化 ====================
(async () => {
    await openDB();
    loadTodayData();
    document.getElementById('connectBtn').addEventListener('click', connectToDevice);
})();