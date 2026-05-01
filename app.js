// ==================== 常量定义 ====================
const SERVICE_UUID = '000018ac-0000-1000-8000-00805f9b34fb';
const NOTIFY_CHAR_UUID = '00002aac-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR_UUID = '00002aad-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_CHAR_UUID = '00002a19-0000-1000-8000-00805f9b34fb';

// 使用 Python 中有效的激活命令
const ACTIVATION_CMD = new Uint8Array([0xDF, 0x00, 0x06, 0xEF, 0x02, 0x04, 0x02, 0x00, 0x01, 0x01]);

// ==================== 全局变量 ====================
let gattServer = null;
let notifyCharacteristic = null;
let writeCharacteristic = null;
let firstPacket = null;
let keepAliveInterval = null;
let db = null;
// 在全局变量区域添加图表实例
let statsChart = null;

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

// ==================== IndexedDB ====================
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
    // 保存完成后，刷新当前图表
    transaction.oncomplete = () => {
        // 获取当前活动按钮的视图类型
        let activeView = 'daily';
        if (document.getElementById('weeklyBtn').classList.contains('active')) activeView = 'weekly';
        else if (document.getElementById('monthlyBtn').classList.contains('active')) activeView = 'monthly';
        renderStats(activeView);
    };
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

// 从 IndexedDB 读取所有历史数据（按日期升序）
async function getAllHistoryData() {
    if (!db) return [];
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => {
            const data = request.result;
            // 按日期排序
            data.sort((a, b) => new Date(a.date) - new Date(b.date));
            resolve(data);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

// 聚合周数据：将日期按周分组，计算每周总步数
function aggregateWeekly(data) {
    const weeks = {};
    data.forEach(entry => {
        const date = new Date(entry.date);
        // 获取该日期所在周的周一日期（ISO 周）
        const dayOfWeek = date.getDay(); // 0周日 ... 6周六
        const diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
        const monday = new Date(date);
        monday.setDate(date.getDate() + diffToMonday);
        const weekKey = monday.toISOString().slice(0,10);
        if (!weeks[weekKey]) {
            weeks[weekKey] = { steps: 0, label: `${weekKey} 周` };
        }
        weeks[weekKey].steps += entry.steps;
    });
    // 转为数组并按日期排序
    const weeksArray = Object.keys(weeks).sort().map(key => ({
        label: key.substring(5) + "周", // 显示 MM-DD 周
        steps: weeks[key].steps
    }));
    return weeksArray;
}

// 聚合月数据
function aggregateMonthly(data) {
    const months = {};
    data.forEach(entry => {
        const yearMonth = entry.date.substring(0,7); // yyyy-mm
        if (!months[yearMonth]) {
            months[yearMonth] = { steps: 0, label: yearMonth };
        }
        months[yearMonth].steps += entry.steps;
    });
    const monthsArray = Object.keys(months).sort().map(key => ({
        label: key,
        steps: months[key].steps
    }));
    return monthsArray;
}

// 渲染图表
async function renderStats(viewType) {
    const history = await getAllHistoryData();
    if (history.length === 0) {
        if (statsChart) statsChart.destroy();
        return;
    }
    let labels = [];
    let stepsData = [];
    let title = '';

    if (viewType === 'daily') {
        // 取最近7天（如果不足7天则全部）
        const last7 = history.slice(-7);
        labels = last7.map(item => item.date.substring(5)); // MM-DD
        stepsData = last7.map(item => item.steps);
        title = '最近7天步数';
    } else if (viewType === 'weekly') {
        const weekly = aggregateWeekly(history);
        labels = weekly.map(w => w.label);
        stepsData = weekly.map(w => w.steps);
        title = '每周总步数';
    } else if (viewType === 'monthly') {
        const monthly = aggregateMonthly(history);
        labels = monthly.map(m => m.label);
        stepsData = monthly.map(m => m.steps);
        title = '每月总步数';
    }

    if (statsChart) statsChart.destroy();
    const ctx = document.getElementById('statsChart').getContext('2d');
    statsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: '步数',
                data: stepsData,
                backgroundColor: 'rgba(0, 122, 255, 0.6)',
                borderColor: '#007aff',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                title: { display: true, text: title },
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: '步数' } },
                x: { title: { display: true, text: viewType === 'daily' ? '日期' : (viewType === 'weekly' ? '周' : '月份') } }
            }
        }
    });
}

// 导出 CSV
async function exportToCSV() {
    console.log('准备导出数据...');
    // 1. 从 IndexedDB 获取所有历史数据
    const allData = await getAllHistoryData();
    if (!allData.length) {
        alert('没有历史数据可导出！');
        return;
    }

    // 2. 将数据转换为 CSV 字符串
    // 定义 CSV 的列头
    const headers = ['日期', '步数', '距离(米)', '卡路里(kcal)'];
    // 将数据映射为行数组
    const rows = allData.map(item => [
        item.date,
        item.steps,
        item.distance,
        (item.calories / 1000).toFixed(2)
    ]);
    // 使用 '\\uFEFF' 解决中文乱码问题
    let csvContent = "\uFEFF" + headers.join(',') + '\n';
    rows.forEach(row => {
        csvContent += row.join(',') + '\n';
    });

    // 3. 创建 Blob 并触发浏览器下载
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    // 以当前日期为文件名
    const today = new Date().toISOString().slice(0,10);
    link.setAttribute('download', `watch_data_${today}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    console.log('数据导出成功！');
}

// 导入 CSV 文件
async function importFromCSV(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (event) => {
            const csvText = event.target.result;
            // 按行分割，过滤空行
            const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');
            if (lines.length === 0) {
                reject('CSV 文件为空');
                return;
            }
            // 检查表头
            const headers = lines[0].split(',');
            const expectedHeaders = ['日期', '步数', '距离(米)', '卡路里'];
            // 简单检查是否匹配预期表头（允许带BOM）
            const cleanHeader = headers[0].replace(/^\uFEFF/, '');
            if (cleanHeader !== expectedHeaders[0]) {
                reject('CSV 格式不正确，请使用导出的标准格式');
                return;
            }
            const records = [];
            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',');
                if (values.length < 4) continue;
                const date = values[0].trim();
                const steps = parseInt(values[1], 10);
                const distance = parseInt(values[2], 10);
                const calories = parseFloat(values[3]) * 1000; // 因为导出的卡路里除以了100，存储时乘以100
                if (isNaN(steps) || isNaN(distance) || isNaN(calories)) continue;
                records.push({ date, steps, distance, calories });
            }
            if (records.length === 0) {
                reject('没有有效数据');
                return;
            }
            // 写入数据库（覆盖已有日期）
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            for (const record of records) {
                await new Promise((res, rej) => {
                    const request = store.put(record);
                    request.onsuccess = () => res();
                    request.onerror = () => rej(request.error);
                });
            }
            transaction.oncomplete = () => {
                console.log(`导入成功，共 ${records.length} 条记录`);
                resolve(records.length);
            };
            transaction.onerror = (e) => reject(e.target.error);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file, 'UTF-8');
    });
}

// 绑定导入按钮事件
function initImport() {
    const importBtn = document.getElementById('importCsvBtn');
    const fileInput = document.getElementById('csvFileInput');
    if (!importBtn || !fileInput) return;
    importBtn.addEventListener('click', () => {
        fileInput.click();
    });
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            await importFromCSV(file);
            alert('导入成功！');
            // 刷新当前图表
            let activeView = 'daily';
            if (document.getElementById('weeklyBtn').classList.contains('active')) activeView = 'weekly';
            else if (document.getElementById('monthlyBtn').classList.contains('active')) activeView = 'monthly';
            await renderStats(activeView);
            // 同时刷新当天显示（如果当天数据有更新）
            await loadTodayData();
        } catch (err) {
            console.error(err);
            alert('导入失败：' + err);
        } finally {
            fileInput.value = ''; // 清空，允许重新选择同一文件
        }
    });
}

// 初始化统计功能：绑定按钮事件，并在数据保存后刷新图表
function initStats() {
    const dailyBtn = document.getElementById('dailyBtn');
    const weeklyBtn = document.getElementById('weeklyBtn');
    const monthlyBtn = document.getElementById('monthlyBtn');
    const exportBtn = document.getElementById('exportCsvBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportToCSV);
    }    

    dailyBtn.addEventListener('click', () => {
        setActiveButton('dailyBtn');
        renderStats('daily');
    });
    weeklyBtn.addEventListener('click', () => {
        setActiveButton('weeklyBtn');
        renderStats('weekly');
    });
    monthlyBtn.addEventListener('click', () => {
        setActiveButton('monthlyBtn');
        renderStats('monthly');
    });
    // 默认显示最近7天
    if (dailyBtn) renderStats('daily');
}

function setActiveButton(activeId) {
    ['dailyBtn', 'weeklyBtn', 'monthlyBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            if (id === activeId) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });
}

// ==================== 保活 ====================
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
        console.warn('保活失败', e);
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

// ==================== 数据处理 ====================
function processData(data) {
    console.log(`处理数据 长度${data.length}: ${buf2hex(data)}`);
    if (data.length === 20 && data[0] === 0xDF) {
        firstPacket = data;
    } else if (data.length === 1 && firstPacket !== null) {
        const steps = (firstPacket[9] << 24) | (firstPacket[10] << 16) | (firstPacket[11] << 8) | firstPacket[12];
        const distance = (firstPacket[13] << 24) | (firstPacket[14] << 16) | (firstPacket[15] << 8) | firstPacket[16];
        const calorie = (firstPacket[17] << 24) | (firstPacket[18] << 16) | (firstPacket[19] << 8) | data[0];
        console.log(`步数=${steps}, 距离=${distance}, 卡路里=${calorie}`);
        updateUI(steps, distance, calorie);
        saveDataToDB(steps, distance, calorie);
        firstPacket = null;
    } else {
        firstPacket = null;
    }
}

// 简化版 handleNotifications，只打印 event.target.value 的原始内容
function handleNotifications(event) {
    const value = event.target.value.buffer;
    if (value && value.byteLength > 0) {
        const data = new Uint8Array(value);
        console.log('通知数据:', buf2hex(data));
        processData(data);
    } else {
        console.warn('收到空通知，value:', value);
        // 不主动读取，避免冲突
    }
}

// ==================== 连接 ====================
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
            filters: [{ name: 'S10Pro' }],
            optionalServices: [SERVICE_UUID, BATTERY_SERVICE_UUID]
        });

        setStatus('正在连接...');
        gattServer = await device.gatt.connect();
        console.log('GATT连接成功');

        // 请求 MTU
        if (gattServer.requestMTU) {
            try {
                const mtu = await gattServer.requestMTU(512);
                console.log('MTU 设置为', mtu);
            } catch (err) {
                console.warn('MTU 请求失败', err);
            }
        }

        setStatus('正在获取服务...');
        const service = await gattServer.getPrimaryService(SERVICE_UUID);
        console.log('服务获取成功');

        notifyCharacteristic = await service.getCharacteristic(NOTIFY_CHAR_UUID);
        writeCharacteristic = await service.getCharacteristic(WRITE_CHAR_UUID);
        console.log('特征获取成功');

        await writeCharacteristic.writeValueWithoutResponse(ACTIVATION_CMD);
        console.log('激活命令已发送');

        await notifyCharacteristic.startNotifications();
        notifyCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);
        console.log('通知订阅成功');

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

// ==================== 清理 ====================
window.addEventListener('beforeunload', () => {
    stopKeepAlive();
    if (gattServer?.connected) gattServer.disconnect();
});

// ==================== 初始化 ====================
(async () => {
    await openDB();
    loadTodayData();      // 加载当日数据到顶部 UI
    initStats();          // 初始化图表（会从 IndexedDB 读取所有历史数据渲染）
    initImport();
    document.getElementById('connectBtn').addEventListener('click', connectToDevice);
})();