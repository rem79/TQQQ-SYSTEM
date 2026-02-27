/**
 * TQQQ SYSTEM - 강인한 데이터 로더 및 지능형 크레딧 매너저 통합 시스템
 */

const CONFIG = {
    apiKey: localStorage.getItem('tqqq_api_key') || '',
    symbols: ['QQQ', 'TQQQ', 'SPY', 'DIA', 'GLD', 'TLT', 'VXX'],
    shortPeriod: 100,
    longPeriod: 200,
    chartPoints: 120,
    updateInterval: 600000,
    dailyLimit: 600,
    storageKey: 'tqqq_system_data_v4',
    maxHistoryPoints: 5000
};


let assetStore = {
    lastUpdate: 0,
    data: {}
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

// --- API 통신 유틸리티 (타임아웃 및 재시도) ---
async function fetchWithTimeout(url, timeout = 10000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

async function fetchWithRetry(url, retries = 2, timeout = 10000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetchWithTimeout(url, timeout);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            if (data.status === 'error') {
                if (data.code === 429) {
                    console.warn("Rate Limit hit, retrying after delay...");
                    await new Promise(r => setTimeout(r, 3000 * (i + 1)));
                    continue;
                }
                throw new Error(data.message || "Unknown API Error");
            }
            return data;
        } catch (e) {
            console.error(`Fetch attempt ${i + 1} failed:`, e.message);
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

async function fetchHistory(symbol) {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=${CONFIG.maxHistoryPoints}&apikey=${CONFIG.apiKey}`;
    try {
        const data = await fetchWithRetry(url);
        if (!data.values || data.values.length === 0) throw new Error(`[${symbol}] No values returned`);
        return data.values.reverse().map(item => ({
            date: item.datetime,
            close: parseFloat(item.close)
        }));
    } catch (e) {
        throw new Error(`[${symbol}] 로딩 실패: ${e.message}`);
    }
}

async function fetchRealtimeQuotes() {
    const symbolsStr = CONFIG.symbols.join(',');
    const url = `https://api.twelvedata.com/quote?symbol=${symbolsStr}&apikey=${CONFIG.apiKey}`;
    try {
        return await fetchWithRetry(url, 1, 5000); // 실시간은 더 짧고 빠르게
    } catch (e) {
        console.error("Quotes load fail:", e);
        return null;
    }
}

async function fetchMyFearAndGreed() {
    const url = `https://raw.githubusercontent.com/rem79/fear-greed-index/main/data.json?v=${Date.now()}`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Fetch failed");
        const data = await response.json();
        if (data && data.stock) {
            return {
                value: data.stock.score,
                status: (data.stock.rating || 'neutral').toUpperCase(),
                date: new Date(data.stock.lastUpdated).toISOString().split('T')[0]
            };
        }
    } catch (e) {
        console.warn("Stock F&G Load fail:", e);
        return null;
    }
}

async function fetchCryptoFearAndGreed() {
    try {
        const response = await fetch('https://api.alternative.me/fng/');
        if (!response.ok) throw new Error("Fetch failed");
        const data = await response.json();
        if (data && data.data && data.data[0]) {
            const item = data.data[0];
            return {
                value: parseInt(item.value),
                status: item.value_classification.toUpperCase(),
                date: new Date(parseInt(item.timestamp) * 1000).toISOString().split('T')[0]
            };
        }
    } catch (e) {
        console.warn("Crypto F&G Load fail:", e);
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
            "공포지수": localStorage.getItem('last_fng_val') || '-'
        };

        CONFIG.symbols.forEach(s => {
            // 날짜가 정확히 일치하지 않는 경우를 대비한 Fallback (데이터 누락 방지)
            row[s] = assetMaps[s][date] || (i > 0 ? integrated[i - 1][s] : null);
        });

        integrated.push(row);
    }
    return integrated;
}

// --- 실행 제어 ---
let mainTimerId = null;

async function startSystem() {
    const statusEl = document.getElementById('phase-description');

    // 1. API 키가 있는 경우 (사용자님 - 관리자 모드)
    if (CONFIG.apiKey) {
        if (loadFromLocal() && assetStore.data.QQQ) {
            statusEl.innerText = "📁 로컬 데이터를 불러왔습니다.";
            globalStrategyResults = processIntegratedData();
            renderDashboard(globalStrategyResults);
            updateUpdateDisplay();
        } else {
            await initialFullLoad();
        }
    }
    // 2. API 키가 없는 경우 (방문자 - 공용 데이터 로드 모드)
    else {
        const updateBtn = document.getElementById('manual-update-btn');
        if (updateBtn) updateBtn.classList.add('hidden'); // 게스트는 업데이트 버튼 숨김

        if (statusEl) statusEl.innerText = "🌐 공용 데이터를 불러오는 중입니다 (조회 전용)...";
        const success = await loadPublicData();

        if (success) {
            if (statusEl) statusEl.innerText = "👀 공용 데이터를 통해 히스토리를 불러왔습니다. (Read-Only)";
            // 게스트 모드에서도 F&G 수집 시도
            const fngRes = await fetchMyFearAndGreed();
            const cryptoFngRes = await fetchCryptoFearAndGreed();
            renderDashboard(globalStrategyResults, null, fngRes, cryptoFngRes);
        } else {
            if (statusEl) statusEl.innerText = "🔑 API 키 설정을 완료해 주세요.";
        }
        checkApiKey(success); // 데이터 로드 성공 시 경고 숨김
    }
}

// 서버의 data.json을 시도하는 새 함수
async function loadPublicData() {
    try {
        const response = await fetch('./data.json?v=' + Date.now());
        if (!response.ok) return false;

        const imported = await response.json();
        const newStore = imported.assetStore || imported;

        if (newStore.data && newStore.data.QQQ) {
            assetStore = newStore;
            if (imported.strategyResults) {
                globalStrategyResults = imported.strategyResults;
            } else {
                globalStrategyResults = processIntegratedData();
            }
            renderDashboard(globalStrategyResults);
            updateUpdateDisplay();

            // 공용 모드인 경우에도 10분 타이머 시작
            startRealtimeTimer();
            if (document.getElementById('realtime-status')) {
                document.getElementById('realtime-status').classList.remove('hidden');
            }
            return true;
        }
    } catch (e) {
        console.warn("Public data not available or error:", e.message);
        return false;
    }
    return false;
}

// --- 실시간 자동 갱신 로직 (10분 주기) ---
let refreshTimer = 600;
let refreshIntervalId = null;

function startRealtimeTimer() {
    if (refreshIntervalId) clearInterval(refreshIntervalId);
    refreshTimer = 600;

    refreshIntervalId = setInterval(() => {
        refreshTimer--;
        const mins = Math.floor(refreshTimer / 60);
        const secs = refreshTimer % 60;
        const display = `${mins}:${secs.toString().padStart(2, '0')}`;
        const counterEl = document.getElementById('refresh-countdown');
        if (counterEl) counterEl.innerText = display;

        if (refreshTimer <= 0) {
            console.log("⏰ 10분 주기 자동 갱신 실행...");
            updateLive();
            refreshTimer = 600;
        }
    }, 1000);
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

        const fngRes = await fetchMyFearAndGreed();
        const cryptoFngRes = await fetchCryptoFearAndGreed();
        renderDashboard(globalStrategyResults, null, fngRes, cryptoFngRes);

        assetStore.lastUpdate = Date.now();
        saveToLocal();
        statusEl.innerText = "✅ 데이터 최적화 로드 완료!";
        updateUpdateDisplay();
        startRealtimeTimer(); // 타이머 시작
        if (document.getElementById('realtime-status')) {
            document.getElementById('realtime-status').classList.remove('hidden');
        }
    } catch (err) {
        statusEl.innerText = `❌ 로딩 지연 발생: ${err.message}`;
    } finally { isLoading = false; }
}

async function updateLive() {
    if (isLoading) return;
    isLoading = true;
    try {
        const [quotes, fngRes, cryptoFngRes] = await Promise.all([
            fetchRealtimeQuotes(),
            fetchMyFearAndGreed(),
            fetchCryptoFearAndGreed()
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

        assetStore.lastUpdate = Date.now();
        saveToLocal();
        globalStrategyResults = processIntegratedData();
        renderDashboard(globalStrategyResults, quotes, fngRes, cryptoFngRes);
        updateUpdateDisplay();

        syncToGitHub();
        startRealtimeTimer(); // 갱신 후 타이머 리셋
    } catch (err) { console.warn("Live Update Fail:", err); }
    finally { isLoading = false; }
}

// --- UI 렌더링 ---
function renderDashboard(results, quotes = null, fng = null, cryptoFng = null) {
    if (!results || results.length === 0) return;
    const latest = results[results.length - 1];

    if (!cryptoFng) {
        fetchCryptoFearAndGreed().then(res => {
            if (res) updateFngGauge('crypto', res);
        });
    } else {
        updateFngGauge('crypto', cryptoFng);
    }

    CONFIG.symbols.forEach(s => {
        const price = (quotes && quotes[s]) ? parseFloat(quotes[s].close) : latest[s];
        if (!price) return;

        if (s === 'VXX') {
            const vVal = document.getElementById('vix-price');
            if (vVal) vVal.innerText = price.toFixed(2);
        } else {
            const priceEl = document.getElementById(`${s.toLowerCase()}-price`);
            if (priceEl) priceEl.innerText = `$${price.toFixed(2)}`;

            // 등락률 표시 개선: quotes가 없으면 히스토리로부터 계산
            let changePercent = null;
            if (quotes && quotes[s]) {
                changePercent = parseFloat(quotes[s].percent_change) || 0;
            } else if (results.length >= 2) {
                const currentPrice = price;
                const prevPrice = results[results.length - 2][s];
                if (currentPrice && prevPrice) {
                    changePercent = ((currentPrice - prevPrice) / prevPrice) * 100;
                }
            }

            if (changePercent !== null) {
                const changeEl = document.getElementById(`${s.toLowerCase()}-change`);
                if (changeEl) {
                    changeEl.innerText = `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`;
                    changeEl.className = changePercent >= 0 ? 'favorable' : 'unfavorable';
                }
            }
        }
    });

    if (fng) {
        updateFngGauge('stock', fng);
    }

    function updateFngGauge(type, data) {
        const valEl = document.getElementById(type === 'stock' ? 'fng-value' : 'crypto-fng-value');
        const statEl = document.getElementById(type === 'stock' ? 'fng-status' : 'crypto-fng-status');
        const needleEl = document.getElementById(type === 'stock' ? 'stock-needle' : 'crypto-needle');
        const pathEl = document.getElementById(type === 'stock' ? 'stock-gauge-path' : 'crypto-gauge-path');

        if (!valEl || !statEl) return;

        const val = data.value;
        valEl.innerText = val;
        statEl.innerText = translateRating(data.status);

        // 색상 결정
        let color = 'var(--fng-neutral)';
        if (val <= 25) color = 'var(--fng-extreme-fear)';
        else if (val <= 44) color = 'var(--fng-fear)';
        else if (val >= 75) color = 'var(--fng-extreme-greed)';
        else if (val >= 56) color = 'var(--fng-greed)';

        valEl.style.color = color;
        statEl.style.color = color;

        // 바늘 회전 (0~100 -> -90~90도)
        const rotation = (val / 100) * 180 - 90;
        if (needleEl) needleEl.style.transform = `translateX(-50%) rotate(${rotation}deg)`;

        // 게이지 패스 업데이트 (stroke-dashoffset)
        // 전체 길이 251.3 (Half circumference of r=80) 
        if (pathEl) {
            const offset = 251.3 - (val / 100) * 251.3;
            pathEl.style.strokeDashoffset = offset;
            pathEl.style.stroke = color;
        }
    }

    function translateRating(rating) {
        const map = {
            'EXTREME FEAR': '극도의 공포',
            'FEAR': '공포',
            'NEUTRAL': '중립',
            'GREED': '탐욕',
            'EXTREME GREED': '극도의 탐욕'
        };
        return map[rating] || rating;
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
                if (col.key === 'VXX' || col.key.includes('SMA')) display = val.toFixed(2);
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
    // 저장할 데이터 패키지 생성 (전체 히스토리 포함)
    const backupData = {
        version: "v4-full-history",
        timestamp: new Date().toISOString(),
        assetStore: assetStore,
        strategyResults: globalStrategyResults,
        config: {
            symbols: CONFIG.symbols,
            maxHistoryPoints: CONFIG.maxHistoryPoints
        }
    };

    const dataStr = JSON.stringify(backupData, null, 2);
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
            const imported = JSON.parse(e.target.result);
            const newStore = imported.assetStore || imported;
            if (!newStore.data || !newStore.data.QQQ) {
                throw new Error("유효한 백업 파일이 아닙니다.");
            }

            if (confirm("기존 데이터를 덮어씌우고 백업 파일을 불러오시겠습니까?")) {
                assetStore = newStore;
                if (imported.strategyResults) {
                    globalStrategyResults = imported.strategyResults;
                }
                saveToLocal();
                alert("데이터 복구 성공! 화면을 새로고침합니다.");
                window.location.reload();
            }
        } catch (err) {
            alert("복구 실패: " + err.message);
        }
    };
    reader.readAsText(file);
}

// --- API 설정 및 보안 기능 ---
function initSettingsUI() {
    const modal = document.getElementById('settings-modal');
    const settingsBtn = document.getElementById('settings-btn');
    const closeBtn = document.getElementById('close-settings-btn');
    const saveBtn = document.getElementById('save-key-btn');
    const keyInput = document.getElementById('api-key-input');

    // GitHub 설정 엘리먼트
    const tokenInput = document.getElementById('github-token-input');
    const repoInput = document.getElementById('github-repo-input');

    if (settingsBtn) {
        settingsBtn.onclick = () => {
            keyInput.value = CONFIG.apiKey;
            if (tokenInput) tokenInput.value = localStorage.getItem('tqqq_github_token') || '';
            if (repoInput) repoInput.value = localStorage.getItem('tqqq_github_repo') || '';
            modal.style.display = 'block';
        };
    }

    if (closeBtn) {
        closeBtn.onclick = () => modal.style.display = 'none';
    }

    if (saveBtn) {
        saveBtn.onclick = () => {
            const newKey = keyInput.value.trim();
            const newToken = tokenInput.value.trim();
            const newRepo = repoInput.value.trim();

            if (newKey) {
                localStorage.setItem('tqqq_api_key', newKey);
                CONFIG.apiKey = newKey;
            }

            if (newToken) localStorage.setItem('tqqq_github_token', newToken);
            if (newRepo) localStorage.setItem('tqqq_github_repo', newRepo);

            modal.style.display = 'none';
            alert("설정이 저장되었습니다.");
            startSystem();
            checkApiKey();
        };
    }
    window.onclick = (event) => {
        if (event.target == modal) modal.style.display = 'none';
    };


    checkApiKey();
}

function checkApiKey(isPublicMode = false) {
    const existingWarning = document.querySelector('.api-warning-bar');
    if (existingWarning) existingWarning.remove();

    const importBtn = document.getElementById('import-btn');

    if (!CONFIG.apiKey) {
        if (importBtn) importBtn.classList.add('hidden');

        // 데이터 로드에 성공한 공용 모드라면 경고 바를 띄우지 않음
        if (isPublicMode) return;

        const warning = document.createElement('div');
        warning.className = 'api-warning-bar';
        warning.innerText = "⚠ Twelve Data API 키가 설정되지 않았습니다. 여기를 클릭하여 설정하세요.";
        warning.onclick = () => document.getElementById('settings-btn').click();
        document.body.prepend(warning);
    } else {
        if (importBtn) importBtn.classList.remove('hidden');
        const updateBtn = document.getElementById('manual-update-btn');
        if (updateBtn) updateBtn.classList.remove('hidden');
    }
}

// --- 초기화 ---
document.addEventListener('DOMContentLoaded', () => {
    initSettingsUI();

    // 로컬 데이터 로드 시도
    if (loadFromLocal()) {
        console.log("Local data loaded.");
        globalStrategyResults = processIntegratedData();
        // 초기 로드 시에도 F&G 시도
        Promise.all([fetchMyFearAndGreed(), fetchCryptoFearAndGreed()]).then(([fng, crypto]) => {
            renderDashboard(globalStrategyResults, null, fng, crypto);
        });
    }

    // 버튼 이벤트 연결
    document.getElementById('export-btn').onclick = exportData;
    document.getElementById('import-btn').onclick = () => document.getElementById('import-input').click();
    document.getElementById('import-input').onchange = importData;
    document.getElementById('manual-update-btn').onclick = updateLive;
    document.getElementById('toggle-full-history').onclick = () => {
        document.getElementById('full-history-container').classList.toggle('hidden')
    };

    // 페이지 로드 시 즉시 실행
    startSystem();
});

// --- GitHub 자동 동기화 로직 ---
async function syncToGitHub() {
    const token = localStorage.getItem('tqqq_github_token');
    const repo = localStorage.getItem('tqqq_github_repo');
    if (!token || !repo) return;

    console.log("🚀 GitHub로 데이터를 자동 전송합니다...");
    const path = 'data.json';
    const url = `https://api.github.com/repos/${repo}/contents/${path}`;

    let sha = '';
    try {
        const getRes = await fetch(url, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }
    } catch (e) { }

    const backupData = {
        version: "v4-manual-sync",
        timestamp: new Date().toISOString(),
        assetStore: assetStore,
        strategyResults: globalStrategyResults
    };

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(backupData, null, 2))));

    try {
        const res = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify({
                message: `Manual-update: ${new Date().toLocaleString()}`,
                content: content,
                sha: sha || undefined
            })
        });

        if (res.ok) console.log("✅ GitHub 동기화 성공!");
    } catch (e) {
        console.error("❌ API 네트워크 오류:", e);
    }
}

// 브러우저 자동 순환 갱신 제거됨
