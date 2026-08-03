/**
 * A股 PWA 数据更新脚本
 * 数据源：新浪财经 API（主） + 东方财富 API（备）
 * 在 GitHub Actions 中每日 15:05 (UTC+8) 自动运行
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

// ===== 配置 =====
const START_DATE = '20260622'; // 数据起始日期
const SINA_DATALEN = 40; // 新浪 API 返回的 K 线条数

const INDICES = [
  { code: 'sh000001', name: '上证指数', secid: '1.000001' },
  { code: 'sh000300', name: '沪深300', secid: '1.000300' }
];

const STOCKS = [
  { code: 'sh600519', name: '贵州茅台', secid: '1.600519' },
  { code: 'sh600995', name: '南网储能', secid: '1.600995' },
  { code: 'sh600570', name: '恒生电子', secid: '1.600570' },
  { code: 'sh601888', name: '中国中免', secid: '1.601888' },
  { code: 'sz001979', name: '招商蛇口', secid: '0.001979' },
  { code: 'sh515080', name: '中证红利低波招商', secid: '1.515080' }
];

const MAOTAI_SECID = '1.600519';

// ===== HTTP 请求（带重试） =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRaw(url, retries = 3, timeout = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://finance.sina.com.cn/',
            'Accept': 'application/json, text/plain, */*'
          },
          timeout
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      });
      return result;
    } catch (e) {
      if (i < retries - 1) {
        const delay = (i + 1) * 1500;
        await sleep(delay);
      } else {
        throw e;
      }
    }
  }
}

async function fetchJson(url, retries = 3) {
  const data = await fetchRaw(url, retries);
  if (!data || data.trim() === '') throw new Error('Empty response');
  return JSON.parse(data);
}

// ===== 新浪 K 线数据（主数据源） =====
async function fetchKlinesSina(symbol) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${SINA_DATALEN}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) return [];
  return data
    .filter(item => item.day >= START_DATE.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))
    .map(item => ({ date: item.day, close: parseFloat(item.close) }));
}

// ===== 东方财富 K 线数据（备选） =====
async function fetchKlinesEastMoney(secid, beg, end) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=0&beg=${beg}&end=${end}`;
  const res = await fetchJson(url);
  if (!res.data || !res.data.klines) return [];
  return res.data.klines.map(line => {
    const parts = line.split(',');
    return { date: parts[0], close: parseFloat(parts[2]) };
  });
}

// ===== 获取 K 线数据（自动切换数据源） =====
async function fetchKlines(item, beg, end) {
  // 优先用新浪 API
  try {
    const klines = await fetchKlinesSina(item.code);
    if (klines.length > 0) return { data: klines, source: 'sina' };
  } catch (e) {
    console.log(`    Sina failed: ${e.message}`);
  }
  // 备选：东方财富
  try {
    const klines = await fetchKlinesEastMoney(item.secid, beg, end);
    if (klines.length > 0) return { data: klines, source: 'eastmoney' };
  } catch (e) {
    console.log(`    EastMoney failed: ${e.message}`);
  }
  return { data: [], source: 'none' };
}

// ===== 获取茅台 PE TTM =====
async function fetchPettm(secid) {
  // 尝试东方财富 push2 API
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f162`;
  try {
    const res = await fetchJson(url, 2);
    if (res.data && res.data.f162 !== undefined && res.data.f162 !== '-') {
      const val = parseFloat(res.data.f162);
      return isNaN(val) ? null : val;
    }
  } catch (e) {
    console.log('    PE TTM (EastMoney) failed:', e.message);
  }
  return null;
}

// ===== 读取现有 data.js =====
function readExistingData() {
  const dataPath = path.join(__dirname, '..', 'data.js');
  if (!fs.existsSync(dataPath)) return null;
  const content = fs.readFileSync(dataPath, 'utf8');
  const lockMatch = content.match(/window\.STOCK_LOCK_COUNT\s*=\s*(\d+)/);
  const dateMatch = content.match(/window\.STOCK_LAST_UPDATE\s*=\s*"([^"]+)"/);
  const rawMatch = content.match(/window\.STOCK_RAW_DATA\s*=\s*(\{[\s\S]*\})/);
  let rawData = null;
  if (rawMatch) {
    try { rawData = JSON.parse(rawMatch[1]); } catch (e) {}
  }
  return {
    lockCount: lockMatch ? parseInt(lockMatch[1]) : 0,
    lastDate: dateMatch ? dateMatch[1] : null,
    rawData
  };
}

// ===== 主流程 =====
async function main() {
  const now = new Date();
  const end = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');

  console.log(`Fetching data from ${START_DATE} to ${end}...`);

  const existing = readExistingData();
  console.log('Existing data:', existing ? `lock=${existing.lockCount}, lastDate=${existing.lastDate}` : 'none');

  // 抓取所有标的的 K 线数据
  const allEntries = [...INDICES, ...STOCKS];
  const klineData = {}; // code -> [{date, close}]

  for (const item of allEntries) {
    const result = await fetchKlines(item, START_DATE, end);
    if (result.data.length > 0) {
      klineData[item.code] = result.data;
      console.log(`  ${item.name} (${item.code}): ${result.data.length} records [${result.source}]`);
    } else {
      console.error(`  ${item.name} (${item.code}): all sources failed`);
      // 如果有旧数据，保留旧数据
      if (existing && existing.rawData) {
        const oldSrc = existing.rawData.indices[item.code] || existing.rawData.stocks[item.code];
        if (oldSrc && existing.rawData.dates) {
          klineData[item.code] = existing.rawData.dates.map((d, i) => ({
            date: d, close: oldSrc.close[i]
          }));
          console.log(`  ${item.name}: using existing data (${klineData[item.code].length} records)`);
        }
      }
    }
    await sleep(500); // 请求间隔
  }

  // 收集所有日期并排序
  const dateSet = new Set();
  for (const code in klineData) {
    for (const k of klineData[code]) {
      dateSet.add(k.date);
    }
  }
  const sortedDates = [...dateSet].sort();

  if (sortedDates.length === 0) {
    console.error('No data fetched, aborting.');
    process.exit(1);
  }

  // 按日期对齐数据（如果某标的某日无数据，用前一日收盘价填充）
  function buildCloseArray(code) {
    const klines = klineData[code];
    if (!klines || klines.length === 0) return [];
    const map = new Map(klines.map(k => [k.date, k.close]));
    const result = [];
    let lastClose = null;
    for (const d of sortedDates) {
      const c = map.get(d);
      if (c != null) {
        lastClose = c;
        result.push(c);
      } else if (lastClose != null) {
        result.push(lastClose);
      } else {
        const future = klines.find(k => k.date > d);
        result.push(future ? future.close : null);
      }
    }
    return result;
  }

  // 构建 indices 和 stocks 对象
  const indices = {};
  for (const idx of INDICES) {
    indices[idx.code] = {
      name: idx.name,
      close: buildCloseArray(idx.code)
    };
  }
  const stocks = {};
  for (const stk of STOCKS) {
    stocks[stk.code] = {
      name: stk.name,
      close: buildCloseArray(stk.code)
    };
  }

  // 计算锁仓计数
  let lockCount = existing ? existing.lockCount : 0;
  if (existing && existing.rawData && existing.rawData.dates) {
    const oldDateSet = new Set(existing.rawData.dates);
    const newDates = sortedDates.filter(d => !oldDateSet.has(d));
    lockCount += newDates.length;
    if (newDates.length > 0) {
      console.log(`New trading days: ${newDates.length} (${newDates.join(', ')})`);
    }
  }

  // 获取茅台 PE TTM
  const pettm = await fetchPettm(MAOTAI_SECID);
  console.log(`Maotai PE TTM: ${pettm}`);

  // 生成 data.js
  const rawData = { dates: sortedDates, indices, stocks };
  const lastDate = sortedDates[sortedDates.length - 1];
  const todayStr = now.toISOString().split('T')[0];

  const content = `// 自动生成于 ${todayStr} — GitHub Actions 每日 15:05 (UTC+8) 更新
// 请勿手动编辑此文件
window.STOCK_LOCK_COUNT = ${lockCount};
window.STOCK_LAST_UPDATE = "${lastDate}";
window.STOCK_MAOTAI_PETTM = ${pettm};
window.STOCK_RAW_DATA = ${JSON.stringify(rawData)};
`;

  const outPath = path.join(__dirname, '..', 'data.js');
  fs.writeFileSync(outPath, content);
  console.log(`\nData updated successfully!`);
  console.log(`  Trading days: ${sortedDates.length}`);
  console.log(`  Lock count: ${lockCount}`);
  console.log(`  Last date: ${lastDate}`);
  console.log(`  PE TTM: ${pettm}`);

  // 检查是否有新数据（用于 GitHub Actions 判断是否需要 commit）
  const oldLastDate = existing && existing.rawData && existing.rawData.dates
    ? existing.rawData.dates[existing.rawData.dates.length - 1] : null;
  const oldCount = existing && existing.rawData && existing.rawData.dates
    ? existing.rawData.dates.length : 0;
  if (oldLastDate === lastDate && oldCount === sortedDates.length) {
    console.log('\nNo new data since last update. Skipping commit.');
    fs.writeFileSync(path.join(__dirname, '..', '.no-update'), '');
  }
}

main().catch(e => {
  console.error('Update failed:', e.message);
  process.exit(1);
});
