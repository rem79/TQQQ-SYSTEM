/**
 * TQQQ SYSTEM - 강인한 데이터 로더 및 지능형 크레딧 매너저 통합 시스템
 */

const CONFIG = {
    apiKey: 'c1c4d7b4fffc4f20bc9d789671b3f958',
    symbols: ['QQQ', 'TQQQ', 'SPY', 'DIA', 'GLD', 'TLT', 'VXX'],
    shortPeriod: 100,
    longPeriod: 200,
    chartPoints: 120,
    updateInterval: 600000,
    dailyLimit: 800,
    storageKey: 'tqqq_system_data_v4',
    maxHistoryPoints: 5000
};

/**
 * 지능형 갱신 주기 계산: (86400초 * 자산수) / 800회 = 108 * N (초)
 */
function calculateSmartInterval() {
    const assetCount = CONFIG.symbols.length;
    const intervalSeconds = Math.ceil((86400 * assetCount) / CONFIG.dailyLimit);
    CONFIG.updateInterval = intervalSeconds * 1000;

    const intervalMin = (intervalSeconds / 60).toFixed(1);
    const el = document.getElementById('smart-interval-val');
    if (el) el.innerText = `약 ${intervalMin}분`;
    console.log(`[SmartInterval] ${intervalMin} min for ${assetCount} assets.`);
    return CONFIG.updateInterval;
}

let assetStore = {
    lastUpdate: 0,
    data: {},
    fngData: []
};

let globalStrategyResults = [];
let qqqChartInstance = null;
let tqqqChartInstance = null;
let isLoading = false;

// --- 유틸리티 ---
function updateUpdateDisplay() {
    const el = document.getElementById('update-time');
    if (!el || !assetStore.lastUpdate) return;
    const date = new Date(assetStore.lastUpdate);
    el.innerText = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

// --- 로컬 저장소 로직 ---
function saveToLocal() {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(assetStore));
}

function loadFromLocal() {
    const saved = localStorage.getItem(CONFIG.storageKey);
    if (saved) {
        try {
            assetStore = JSON.parse(saved);
            return true;
        } catch (e) { return false; }
    }
    return false;
}

// --- API 통신 (강인한 로딩 모드) ---
async function fetchWithRetry(url, retries = 3, backoff = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 'error') {
                if (data.code === 429) {
                    console.warn("API Rate Limit hit, waiting longer...");
                    await new Promise(r => setTimeout(r, backoff * (i + 1)));
                    continue;
                }
                throw new Error(data.message);
            }
            return data;
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, backoff));
        }
    }
}

async function fetchHistory(symbol) {
    try {
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=${CONFIG.maxHistoryPoints}&apikey=${CONFIG.apiKey}`;
        const data = await fetchWithRetry(url);
        return data.values.reverse().map(item => ({
            date: item.datetime,
            close: parseFloat(item.close)
        }));
    } catch (e) {
        console.error(`History load fail [${symbol}]:`, e);
        return [];
    }
}

async function fetchRealtimeQuotes() {
    const symbolsStr = CONFIG.symbols.join(',');
    const url = `https://api.twelvedata.com/quote?symbol=${symbolsStr}&apikey=${CONFIG.apiKey}`;
    try {
        return await fetchWithRetry(url, 2, 1000);
    } catch (e) {
        console.error("Quotes load fail:", e);
        return null;
    }
}

async function fetchCNNFearAndGreed() {
    try {
        const url = `https://api.allorigins.win/get?url=${encodeURIComponent('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/')}`;
        const response = await fetch(url);
        const rawData = await response.json();
        const data = JSON.parse(rawData.contents);

        const current = data.fear_and_greed;
        const historical = data.fear_and_greed_historical;

        const historyList = [];
        if (historical && historical.timestamp && historical.data) {
            for (let i = 0; i < historical.timestamp.length; i++) {
                const dateObj = new Date(historical.timestamp[i]);
                const dateStr = dateObj.toISOString().split('T')[0];
                historyList.push({ date: dateStr, value: historical.data[i] });
            }
        }

        return {
            current: {
                value: Math.round(current.score),
                status: current.rating.toUpperCase()
            },
            history: historyList
        };
    } catch (e) {
        console.error("CNN F&G load fail:", e);
        return null;
    }
}

// --- 분석 로직 ---
function calculateSMA(data, period) {
    let sma = [];
    if (!data || data.length < period) return new Array(data ? data.length : 0).fill(null);
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) { sma.push(null); continue; }
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j].close;
        sma.push(sum / period);
    }
    return sma;
}

function processIntegratedData() {
    const mainSymbol = 'QQQ';
    const qqq = assetStore.data[mainSymbol] || [];
    if (qqq.length === 0) return [];

    const smas = {};
    CONFIG.symbols.forEach(s => {
        const d = assetStore.data[s] || [];
        smas[s] = {
            s100: calculateSMA(d, CONFIG.shortPeriod),
            s200: calculateSMA(d, CONFIG.longPeriod)
        };
    });

    let currentPhase = 'HEDGE';
    let integrated = [];
    const assetMaps = {};
    CONFIG.symbols.forEach(s => {
        assetMaps[s] = (assetStore.data[s] || []).reduce((acc, curr) => {
            acc[curr.date] = curr.close;
            return acc;
        }, {});
    });

    const fngMap = (assetStore.fngData || []).reduce((acc, curr) => {
        acc[curr.date] = curr.value;
        return acc;
    }, {});

    for (let i = 0; i < qqq.length; i++) {
        const date = qqq[i].date;
        const qPrice = qqq[i].close;
        const qs100 = smas['QQQ'].s100[i];
        const qs200 = smas['QQQ'].s200[i];

        if (qs100 && qs200) {
            if (currentPhase === 'HEDGE' && qPrice > qs100 && qPrice > qs200) currentPhase = 'LONG';
            else if (currentPhase === 'LONG' && qPrice < qs200) currentPhase = 'HEDGE';
        }

        const row = {
            date: date,
            phase: currentPhase,
            signal: (i > 0 && integrated[i - 1] && currentPhase !== integrated[i - 1].phase) ? (currentPhase === 'LONG' ? 'BUY' : 'SELL') : null,
            SMA100: qs100,
            SMA200: qs200,
            "공포지수": fngMap[date] || '-'
        };

        CONFIG.symbols.forEach(s => {
            row[s] = assetMaps[s][date] || null;
        });

        integrated.push(row);
    }
    return integrated;
}

// --- 실행 제어 ---
async function startSystem() {
    const statusEl = document.getElementById('phase-description');
    calculateSmartInterval();

    if (loadFromLocal() && assetStore.data.QQQ) {
        statusEl.innerText = "📁 로컬 데이터를 불러왔습니다. 부족한 데이터를 보충합니다...";
        globalStrategyResults = processIntegratedData();
        renderDashboard(globalStrategyResults);
        updateUpdateDisplay();

        const missingSymbols = CONFIG.symbols.filter(s => !assetStore.data[s] || assetStore.data[s].length === 0);
        if (missingSymbols.length > 0) {
            await initialFullLoad(missingSymbols);
        } else {
            if (Date.now() - assetStore.lastUpdate > CONFIG.updateInterval) updateLive();
        }
    } else {
        await initialFullLoad();
    }

    setInterval(() => {
        if (Date.now() - assetStore.lastUpdate > CONFIG.updateInterval) updateLive();
    }, 60000);
}

async function initialFullLoad(targetSymbols = CONFIG.symbols) {
    if (isLoading) return;
    isLoading = true;
    const statusEl = document.getElementById('phase-description');

    try {
        for (let i = 0; i < targetSymbols.length; i++) {
            const symbol = targetSymbols[i];
            statusEl.innerText = `🚀 데이터 수집 [${symbol}] (${i + 1}/${targetSymbols.length})...`;

            const history = await fetchHistory(symbol);
            if (history.length > 0) {
                assetStore.data[symbol] = history;
                globalStrategyResults = processIntegratedData();
                renderDashboard(globalStrategyResults);
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        if (!assetStore.fngData || assetStore.fngData.length === 0) {
            statusEl.innerText = `🚀 심리 지표 수집 중...`;
            const cnnRes = await fetchCNNFearAndGreed();
            if (cnnRes) {
                assetStore.fngData = cnnRes.history;
                renderDashboard(processIntegratedData(), null, cnnRes.current);
            }
        }

        assetStore.lastUpdate = Date.now();
        saveToLocal();
        statusEl.innerText = "✅ 데이터 최적화 로드 완료!";
        updateUpdateDisplay();
    } catch (err) {
        statusEl.innerText = `❌ 로딩 지연 발생: ${err.message}`;
    } finally { isLoading = false; }
}

async function updateLive() {
    if (isLoading) return;
    isLoading = true;
    try {
        const [quotes, cnnRes] = await Promise.all([
            fetchRealtimeQuotes(),
            fetchCNNFearAndGreed()
        ]);

        if (quotes) {
            CONFIG.symbols.forEach(s => {
                const q = quotes[s];
                if (q && q.close) {
                    const latestPrice = parseFloat(q.close);
                    if (!assetStore.data[s]) assetStore.data[s] = [];
                    const dataArr = assetStore.data[s];
                    if (dataArr.length > 0) {
                        dataArr[dataArr.length - 1].close = latestPrice;
                    }
                }
            });
        }

        if (cnnRes) {
            assetStore.fngData = cnnRes.history;
        }

        assetStore.lastUpdate = Date.now();
        saveToLocal();
        globalStrategyResults = processIntegratedData();
        renderDashboard(globalStrategyResults, quotes, cnnRes ? cnnRes.current : null);
        updateUpdateDisplay();
    } catch (err) { console.warn("Live Update Fail:", err); }
    finally { isLoading = false; }
}

// --- UI 렌더링 ---
function renderDashboard(results, quotes = null, fng = null) {
    if (!results || results.length === 0) return;
    const latest = results[results.length - 1];

    CONFIG.symbols.forEach(s => {
        const price = (quotes && quotes[s]) ? parseFloat(quotes[s].close) : latest[s];
        if (!price) return;

        if (s === 'VXX') {
            const vVal = document.getElementById('vix-price');
            if (vVal) vVal.innerText = price.toFixed(2);
        } else {
            const priceEl = document.getElementById(`${s.toLowerCase()}-price`);
            if (priceEl) priceEl.innerText = `$${price.toFixed(2)}`;
            if (quotes && quotes[s]) {
                const changeEl = document.getElementById(`${s.toLowerCase()}-change`);
                if (changeEl) {
                    const c = parseFloat(quotes[s].percent_change) || 0;
                    changeEl.innerText = `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;
                    changeEl.className = c >= 0 ? 'favorable' : 'unfavorable';
                }
            }
        }
    });

    if (fng) {
        const fVal = document.getElementById('fng-value');
        const fStat = document.getElementById('fng-status');
        if (fVal && fStat) {
            fVal.innerText = fng.value;
            fStat.innerText = fng.status;
            const color = fng.value < 25 ? '#ff4d4d' : (fng.value > 75 ? '#00ffa3' : '#ffd700');
            fVal.style.color = color;
            fStat.style.color = color;
        }
    }

    document.getElementById('current-phase').innerText = latest.phase === 'LONG' ? 'LONG PHASE' : 'HEDGE PHASE';
    document.getElementById('current-phase').className = 'phase-badge ' + (latest.phase === 'LONG' ? 'long-badge' : 'hedge-badge');
    document.getElementById('phase-description').innerText = latest.phase === 'LONG' ? '✅ 실전 매매 신호: TQQQ 풀매수' : '🛡️ 실전 매매 신호: 전량 매도';

    document.getElementById('sma100-val').innerText = latest.SMA100 ? latest.SMA100.toFixed(2) : '-';
    document.getElementById('sma200-val').innerText = latest.SMA200 ? latest.SMA200.toFixed(2) : '-';

    renderDynamicFullHistory(results);
    renderCharts(results);
}

function renderDynamicFullHistory(results) {
    const table = document.getElementById('full-signal-history');
    if (!table || !results) return;

    const columns = [
        { label: '날짜', key: 'date' },
        { label: '페이즈', key: 'phase' },
        { label: '신호', key: 'signal' },
        { label: 'SMA100', key: 'SMA100' },
        { label: 'SMA200', key: 'SMA200' },
        { label: '공포지수', key: '공포지수' },
        ...CONFIG.symbols.map(s => ({ label: s, key: s }))
    ];

    let headerHTML = `<thead><tr>${columns.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>`;
    const reversed = [...results].reverse();
    let bodyHTML = '<tbody>';
    reversed.forEach(row => {
        bodyHTML += '<tr>';
        columns.forEach(col => {
            const val = row[col.key];
            let display = (val === null || val === undefined || val === '-') ? '-' : val;
            let className = '';

            if (col.key === 'signal' && val) className = val === 'BUY' ? 'signal-buy' : 'signal-sell';
            if (typeof val === 'number') {
                if (col.key === '공포지수' || col.key === 'VXX' || col.key.includes('SMA')) display = val.toFixed(2);
                else if (col.key !== 'date') display = `$${val.toFixed(2)}`;
            }
            bodyHTML += `<td class="${className}">${display}</td>`;
        });
        bodyHTML += '</tr>';
    });
    bodyHTML += '</tbody>';
    table.innerHTML = headerHTML + bodyHTML;
}

function renderCharts(results) {
    const displayData = results.slice(-CONFIG.chartPoints);
    const labels = displayData.map(d => d.date);
    if (qqqChartInstance) {
        qqqChartInstance.data.labels = labels;
        qqqChartInstance.data.datasets[0].data = displayData.map(d => d.QQQ);
        qqqChartInstance.data.datasets[1].data = displayData.map(d => d.SMA100);
        qqqChartInstance.data.datasets[2].data = displayData.map(d => d.SMA200);
        qqqChartInstance.update('none');
    } else {
        const ctxQ = document.getElementById('qqqChart');
        if (ctxQ) qqqChartInstance = new Chart(ctxQ.getContext('2d'), getChartConfig('QQQ', '#58a6ff', displayData, 'QQQ', 'SMA100', 'SMA200'));
    }
    if (tqqqChartInstance) {
        tqqqChartInstance.data.labels = labels;
        tqqqChartInstance.data.datasets[0].data = displayData.map(d => d.TQQQ);
        tqqqChartInstance.update('none');
    } else {
        const ctxT = document.getElementById('tqqqChart');
        if (ctxT) tqqqChartInstance = new Chart(ctxT.getContext('2d'), getChartConfig('TQQQ', '#00ff77', displayData, 'TQQQ', null, null));
    }
}

function getChartConfig(label, color, displayData, key, s1, s2) {
    const datasets = [{ label: `${label} 가격`, data: displayData.map(d => d[key]), borderColor: color, borderWidth: 2, pointRadius: 0 }];
    if (s1) datasets.push({ label: 'SMA 100', data: displayData.map(d => d[s1]), borderColor: '#fab005', borderWidth: 1.2, pointRadius: 0, borderDash: [5, 5] });
    if (s2) datasets.push({ label: 'SMA 200', data: displayData.map(d => d[s2]), borderColor: '#be4bdb', borderWidth: 1.2, pointRadius: 0 });
    return { type: 'line', data: { labels: displayData.map(d => d.date), datasets }, options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, color: '#8b949e' } }, y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e' } } } } };
}

function exportData() {
    const dataStr = JSON.stringify(assetStore, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const exportFileDefaultName = `tqqq_system_backup_${new Date().toISOString().slice(0, 10)}.json`;
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const importedData = JSON.parse(e.target.result);
            if (!importedData.data || !importedData.data.QQQ) throw new Error("유효한 백업 파일이 아닙니다.");
            if (confirm("기존 데이터를 덮어씌우고 백업 파일을 불러오시겠습니까?")) {
                assetStore = importedData;
                saveToLocal();
                alert("데이터 복구가 완료되었습니다.");
                window.location.reload();
            }
        } catch (err) { alert("복구 실패: " + err.message); }
    };
    reader.readAsText(file);
}

document.addEventListener('DOMContentLoaded', () => {
    startSystem();
    document.getElementById('manual-update-btn').addEventListener('click', updateLive);
    document.getElementById('toggle-full-history').addEventListener('click', () => {
        document.getElementById('full-history-container').classList.toggle('hidden');
    });
    document.getElementById('export-btn').addEventListener('click', exportData);
    document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-input').click());
    document.getElementById('import-input').addEventListener('change', importData);
});
