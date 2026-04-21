// ==================== 常量定义 ====================
const SERVICE_UUID = '000018ac-0000-1000-8000-00805f9b34fb';
const NOTIFY_CHAR_UUID = '00002aac-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR_UUID = '00002aad-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_CHAR_UUID = '00002a19-0000-1000-8000-00805f9b34fb';
// 激活命令 (DF 00 06 EF 02 04 02 00 01 01)
const ACTIVATION_CMD = new Uint8Array([0xDF, 0x00, 0x06, 0xEF, 0x02, 0x04, 0x02, 0x00, 0x01, 0x01]);

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
    // 假设卡路里原始值是 kcal 的 100 倍（例如 7230 -> 72.30）
    document.getElementById('calories').innerText = (calorie / 100).toFixed(2);
}

function setStatus(message, isError = false) {
    const statusDiv = document.getElementById('statusArea');
    statusDiv.innerHTML = message;
    if (isError) {
        statusDiv.style.color = '#ff3b30';
    } else {
        statusDiv.style.color = '#666';
    }
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
        request.onerror = (event) => {
            console.error('IndexedDB error:', event.target.error);
            reject(event.target.error);
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('IndexedDB opened successfully');
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'date' });
                objectStore.createIndex('steps', 'steps', { unique: false });
                objectStore.createIndex('calories', 'calories', { unique: false });
                console.log('Object store created');
            }
        };
    });
}

function saveDataToDB(steps, distance, calories) {
    if (!db) {
        console.warn('Database not ready, data not saved');
        return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const data = { date: today, steps, distance, calories };
    const request = store.put(data);
    request.onerror = (event) => {
        console.error('Error saving data to DB', event.target.error);
    };
    request.onsuccess = () => {
        console.log('Data saved to DB', data);
    };
}

function loadTodayData() {
    if (!db) return;
    const today = new Date().toISOString().slice(0, 10);
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(today);
    request.onsuccess = (event) => {
        if (request.result) {
            const { steps, distance, calories } = request.result;
            updateUI(steps, distance, calories);
            console.log('Loaded today\'s data from DB');
        }
    };
    request.onerror = (event) => {
        console.error('Error loading today\'s data', event.target.error);
    };
}

// ==================== 保活机制 ====================
async function keepAlive() {
    if (!gattServer || !gattServer.connected) {
        console.log('Keep-alive: not connected');
        return;
    }
    try {
        const service = await gattServer.getPrimaryService(BATTERY_SERVICE_UUID);
        const char = await service.getCharacteristic(BATTERY_CHAR_UUID);
        const value = await char.readValue();
        const batteryLevel = value.getUint8(0);
        console.log(`保活 - 电池电量: ${batteryLevel}%`);
        setStatus(`连接正常，电量 ${batteryLevel}%`);
    } catch (e) {
        console.warn('Keep-alive read failed, connection may be lost', e);
        // 如果读取失败，可能连接已断开，清除定时器
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        setStatus('连接已断开，请重新连接', true);
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('dataArea').style.display = 'none';
    }
}

function startKeepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(keepAlive, 30000); // 每30秒保活一次
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// ==================== 通知数据处理 ====================
function handleNotifications(event) {
    const data = new Uint8Array(event.target.value);
    console.log(`收到数据 (长度 ${data.length}): ${buf2hex(data)}`);

    if (data.length === 20 && data[0] === 0xDF) {
        // 第一条数据包，暂存
        firstPacket = data;
    } else if (data.length === 1 && firstPacket !== null) {
        // 第二条数据包，开始解析
        const steps = (firstPacket[9] << 24) | (firstPacket[10] << 16) | (firstPacket[11] << 8) | firstPacket[12];
        const distance = (firstPacket[13] << 24) | (firstPacket[14] << 16) | (firstPacket[15] << 8) | firstPacket[16];
        // 卡路里：第一条包索引17-19（3字节） + 第二条包（1字节）
        const calorieBytes = new Uint8Array([firstPacket[17], firstPacket[18], firstPacket[19], data[0]]);
        const calorie = (calorieBytes[0] << 24) | (calorieBytes[1] << 16) | (calorieBytes[2] << 8) | calorieBytes[3];
        
        console.log(`解析结果: 步数=${steps}, 距离=${distance}, 卡路里=${calorie}`);
        updateUI(steps, distance, calorie);
        saveDataToDB(steps, distance, calorie);
        
        firstPacket = null; // 重置状态
    } else {
        // 意外的数据包，重置状态
        firstPacket = null;
    }
}

// ==================== 蓝牙连接与激活 ====================
async function connectToDevice() {
    // 清理之前的连接
    if (gattServer && gattServer.connected) {
        try {
            await gattServer.disconnect();
        } catch (e) {
            console.warn('Disconnect error', e);
        }
    }
    stopKeepAlive();
    firstPacket = null;
    
    try {
        setStatus('正在请求设备...');
        const device = await navigator.bluetooth.requestDevice({
            // filters: [{ name: 'S10Pro' }],
            acceptAllDevices: true,
            optionalServices: [SERVICE_UUID, BATTERY_SERVICE_UUID]
        });
        
        if (!device.gatt) {
            throw new Error('所选设备不支持 GATT 服务。');
        }
        
        setStatus('正在连接 GATT 服务器...');
        gattServer = await device.gatt.connect();
        console.log('GATT 服务器已连接', gattServer);
        
        setStatus('正在获取服务...');
        const service = await gattServer.getPrimaryService(SERVICE_UUID);
        console.log('已获取服务', service);
        
        setStatus('正在获取特征...');
        notifyCharacteristic = await service.getCharacteristic(NOTIFY_CHAR_UUID);
        writeCharacteristic = await service.getCharacteristic(WRITE_CHAR_UUID);
        console.log('已获取特征');
        
        // 启用通知
        setStatus('正在启用通知...');
        await notifyCharacteristic.startNotifications();
        notifyCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);
        
        // 发送激活命令
        setStatus('正在发送激活命令...');
        await writeCharacteristic.writeValue(ACTIVATION_CMD);
        console.log('激活命令已发送');
        
        // 启动保活
        startKeepAlive();
        
        // 更新 UI
        document.getElementById('connectBtn').disabled = true;
        document.getElementById('dataArea').style.display = 'block';
        clearError();
        setStatus('已连接，等待数据...');
        
        // 加载今日已有数据
        loadTodayData();
        
    } catch (error) {
        console.error('连接错误:', error);
        showError(error.message);
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('dataArea').style.display = 'none';
        if (gattServer && gattServer.connected) {
            try {
                await gattServer.disconnect();
            } catch (e) {}
        }
        stopKeepAlive();
    }
}

// ==================== 页面卸载时清理 ====================
window.addEventListener('beforeunload', () => {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    if (gattServer && gattServer.connected) {
        gattServer.disconnect();
    }
});

// ==================== Service Worker 注册 ====================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Service Worker registered', reg))
            .catch(err => console.log('Service Worker registration failed', err));
    });
}

// ==================== 初始化 IndexedDB 和事件绑定 ====================
(async () => {
    await openDB();
    // 页面加载时尝试加载今日数据（可能无连接时显示上次记录）
    loadTodayData();
    
    const connectBtn = document.getElementById('connectBtn');
    connectBtn.addEventListener('click', connectToDevice);
})();