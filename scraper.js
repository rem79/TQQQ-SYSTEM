const fs = require('fs');

/**
 * TQQQ SYSTEM - GitHub Actions 전용 데이터 업데이트 스크립트
 */

const CONFIG = {
    apiKey: process.env.TWELVE_DATA_API_KEY,
    symbols: ['QQQ', 'TQQQ', 'SPY', 'DIA', 'GLD', 'TLT', 'VXX'],
    shortPeriod: 100,
    longPeriod: 200,
    maxHistoryPoints: 5000,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL
};

async function sendDiscordNotification(currentPhase, previousPhase, qPrice) {
    if (!CONFIG.discordWebhookUrl) return;

    // 페이즈가 변한 경우에만 알림 전송
    if (currentPhase === previousPhase) return;

    console.log(`🔔 페이즈 변화 감지: ${previousPhase} -> ${currentPhase}. 디스코드 알림을 전송합니다.`);

    const message = {
        username: "TQQQ SYSTEM",
        avatar_url: "https://cdn-icons-png.flaticon.com/512/2502/2502164.png",
        embeds: [{
            title: `🚨 전략 페이즈 전환: ${previousPhase} ➔ ${currentPhase}`,
            description: `**현재 시각:** ${new Date().toLocaleString('ko-KR')}\n**QQQ 현재가:** $${qPrice.toFixed(2)}\n\n**매매 신호:** ${currentPhase === 'LONG' ? '✅ TQQQ 풀매수 시작' : '🛡️ 전량 매도 및 현금화'}`,
            color: currentPhase === 'LONG' ? 3066993 : 15158332, // LONG: 녹색, HEDGE: 빨간색
            footer: { text: "TQQQ System Automated Alert" },
            timestamp: new Date().toISOString()
        }]
    };

    try {
        await fetch(CONFIG.discordWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message)
        });
        console.log("✅ 디스코드 알림 전송 성공!");
    } catch (e) {
        console.error("❌ 디스코드 알림 실패:", e.message);
    }
}

async function fetchData() {
    console.log("🚀 데이터 업데이트 시작...");

    if (!CONFIG.apiKey) {
        console.error("❌ TWELVE_DATA_API_KEY 환경 변수가 없습니다.");
        process.exit(1);
    }

    const assetStore = {
        lastUpdate: Date.now(),
        data: {}
    };

    // 1. 각 심볼별 히스토리 데이터 로드
    for (const symbol of CONFIG.symbols) {
        console.log(`📡 [${symbol}] 데이터 로딩 중...`);
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=${CONFIG.maxHistoryPoints}&apikey=${CONFIG.apiKey}`;

        try {
            const res = await fetch(url);
            const data = await res.json();

            if (data.status === 'error' || !data.values) {
                console.warn(`⚠️ [${symbol}] 경고: ${data.message || '데이터 없음'}`);
                continue;
            }

            assetStore.data[symbol] = data.values.reverse().map(item => ({
                date: item.datetime,
                close: parseFloat(item.close)
            }));
            console.log(`✅ [${symbol}] ${assetStore.data[symbol].length}일 데이터 확보`);
        } catch (e) {
            console.error(`❌ [${symbol}] 네트워크 오류:`, e.message);
        }
    }

    // 2. 공포와 탐욕 지수 로드
    let fngScore = '-';
    try {
        console.log("📡 공포와 탐욕 지수 로딩 중...");
        const fngUrl = `https://raw.githubusercontent.com/rem79/fear-greed-index/main/data.json`;
        const fngRes = await fetch(fngUrl);
        const fngData = await fngRes.json();
        if (fngData && fngData.stock) {
            fngScore = fngData.stock.score;
        }
    } catch (e) {
        console.warn("⚠️ F&G 로딩 실패");
    }

    // 3. 전략 분석 실행
    // 이전 데이터 로드 (페이즈 변화 감지용)
    let previousData = null;
    try {
        if (fs.existsSync('data.json')) {
            const oldContent = JSON.parse(fs.readFileSync('data.json', 'utf8'));
            if (oldContent.strategyResults && oldContent.strategyResults.length > 0) {
                previousData = oldContent.strategyResults[oldContent.strategyResults.length - 1];
            }
        }
    } catch (e) { console.warn("이전 데이터 로드 실패 (첫 실행으로 간주)"); }

    const strategyResults = processIntegratedData(assetStore, fngScore);
    const latestResult = strategyResults[strategyResults.length - 1];

    // 페이즈 변화 체크 및 알림
    if (previousData && latestResult && previousData.phase !== latestResult.phase) {
        await sendDiscordNotification(latestResult.phase, previousData.phase, latestResult.QQQ);
    }

    // 4. data.json 파일 저장
    const finalData = {
        version: "v4-actions-sync",
        timestamp: new Date().toISOString(),
        assetStore: assetStore,
        strategyResults: strategyResults
    };

    fs.writeFileSync('data.json', JSON.stringify(finalData, null, 2));
    console.log("✨ data.json 업데이트 완료!");
}

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

function processIntegratedData(assetStore, fngScore) {
    const qqq = assetStore.data['QQQ'] || [];
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
            "공포지수": fngScore // 최신 값은 최신 스크래핑 결과 활용
        };

        CONFIG.symbols.forEach(s => {
            row[s] = assetMaps[s][date] || (i > 0 ? integrated[i - 1][s] : null);
        });

        integrated.push(row);
    }
    return integrated;
}

fetchData();
