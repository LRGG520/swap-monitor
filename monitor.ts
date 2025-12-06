import { Endless, EndlessConfig, Network } from "@endlesslab/endless-ts-sdk";
import express from 'express';
import cors from 'cors';
import * as fs from 'fs';

// ==========================================
// 🛡️ 错误拦截
// ==========================================
const IGNORE_ERRORS = ['onCancel', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'socket hang up'];
process.on('uncaughtException', (err: any) => {
    if (IGNORE_ERRORS.some(e => (err.message || '').includes(e))) return;
    console.error('❌ [System Error]', err);
});
process.on('unhandledRejection', () => {});

// === 1. 核心配置 ===
const RPC_NODE_URL = "https://rpc.endless.link/v1";
const SLISWAP_ADDR = "SwapBAzMqRdX9RBXcaBnupiPmfmk1wDcLPPQiy1mehh";
const EDS_ID = "ENDLESSsssssssssssssssssssssssssssssssssssss";
const DECIMALS = 8;
const DB_FILE = "history_data.json";
// 🔴 只有第一次运行(没有存档时)才会用这个高度
const GENESIS_START_HEIGHT = 108106850n; 

// ⚡ 性能配置
const BATCH_SIZE = 100;   
const CONCURRENCY = 10;   

// === 2. 初始化 ===
const app = express();
app.use(cors());
app.use(express.static('.')); // 托管前端网页

const config = new EndlessConfig({
    fullnode: RPC_NODE_URL,
    network: Network.MAINNET,
});
const endless = new Endless(config);

// === 3. 数据层 ===
interface TxRecord {
    hash: string;
    sender: string;
    buyAmount: number;
    sellAmount: number;
    timestamp: number;
    version: string;
}

// 内存状态
let allTransactions: TxRecord[] = [];
let processedVersions = new Set<string>();
let currentChainHeight = 0n; // 链上最新高度
let scanProgressHeight = GENESIS_START_HEIGHT; // 我们扫描到的进度 (检查点)
let isSyncing = true; 

// [升级版] 读档
function loadData() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE, 'utf-8');
            const data = JSON.parse(raw);
            
            // 恢复交易记录
            allTransactions = data.transactions || [];
            allTransactions.forEach(tx => processedVersions.add(tx.version));
            
            // 恢复扫描进度 (关键升级)
            if (data.lastScannedBlock) {
                const savedProgress = BigInt(data.lastScannedBlock);
                // 只有当存档进度大于配置的起始高度时，才采纳存档
                if (savedProgress > scanProgressHeight) {
                    scanProgressHeight = savedProgress;
                }
            }
            
            console.log(`📂 存档已加载: ${allTransactions.length} 笔交易 | 进度检查点: ${scanProgressHeight}`);
        } catch (e) { console.error("读取存档失败", e); }
    }
}

// [升级版] 存档
function saveData() {
    try {
        // 按版本号排序确保有序
        allTransactions.sort((a, b) => Number(BigInt(b.version) - BigInt(a.version)));
        
        const payload = {
            lastUpdate: Date.now(),
            // 💾 核心：保存当前的扫描进度，而不仅仅是交易数据
            lastScannedBlock: scanProgressHeight.toString(), 
            transactions: allTransactions
        };
        
        fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2));
    } catch (e) { console.error("保存失败", e); }
}

loadData();

// === 4. 业务逻辑 ===

function parseTx(tx: any): TxRecord | null {
    if (tx.type !== 'user_transaction') return null;
    const events = tx.events || [];
    let buyRaw = 0n;
    let sellRaw = 0n;
    const timestamp = parseInt(tx.timestamp) / 1000; 

    for (const event of events) {
        const type = event.type || "";
        if (!type.includes(SLISWAP_ADDR) || !type.includes("SwapEvent")) continue;

        const data = event.data;
        const tokenIn = data.token_in || "";
        const tokenOut = data.token_out || "";

        if (tokenIn.includes(EDS_ID)) sellRaw += BigInt(data.amount_in || 0);
        else if (tokenOut.includes(EDS_ID)) buyRaw += BigInt(data.amount_out || 0);
    }

    if (buyRaw > 0n || sellRaw > 0n) {
        return {
            hash: tx.hash,
            sender: tx.sender,
            buyAmount: Number(buyRaw) / (10 ** DECIMALS),
            sellAmount: Number(sellRaw) / (10 ** DECIMALS),
            timestamp: timestamp,
            version: tx.version
        };
    }
    return null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchBatchWithRetry(offset: bigint, limit: number): Promise<any[]> {
    let retries = 3;
    let delay = 1000;
    while (retries > 0) {
        try {
            return await endless.getTransactions({ options: { offset: offset.toString(), limit: limit } });
        } catch (e: any) {
            retries--;
            if (retries === 0) return [];
            await sleep(delay);
            delay *= 1.5;
        }
    }
    return [];
}

// 🚀 智能同步引擎
async function fastSync() {
    console.log(`🚀 启动智能同步 (断点续传: ${scanProgressHeight})...`);
    
    try {
        const info = await endless.getLedgerInfo();
        currentChainHeight = BigInt(info.ledger_version);
    } catch (e) { console.error("连接 RPC 失败，请检查网络"); return; }

    // 直接从 scanProgressHeight 开始，不再重新计算
    let cursor = scanProgressHeight; 

    console.log(`🎯 目标高度: ${currentChainHeight}, 待扫描区块: ${currentChainHeight - cursor}`);

    while (cursor < currentChainHeight) {
        const promises = [];
        // 并发请求
        for (let i = 0; i < CONCURRENCY; i++) {
            const offset = cursor + BigInt(i * BATCH_SIZE);
            if (offset > currentChainHeight) break;
            promises.push(
                fetchBatchWithRetry(offset, BATCH_SIZE)
                .then(txs => txs.map(tx => parseTx(tx)).filter(t => t !== null))
            );
        }

        if (promises.length === 0) break;

        const results = await Promise.all(promises);
        
        let newCount = 0;
        // @ts-ignore
        results.flat().forEach((record: TxRecord) => {
            if (record && !processedVersions.has(record.version)) {
                processedVersions.add(record.version);
                allTransactions.push(record);
                newCount++;
            }
        });

        // 推进游标
        const processedCount = BigInt(promises.length * BATCH_SIZE);
        cursor += processedCount;
        scanProgressHeight = cursor; // 更新全局进度

        // 打印进度
        const percent = Number(cursor - GENESIS_START_HEIGHT) / Number(currentChainHeight - GENESIS_START_HEIGHT) * 100;
        process.stdout.write(`\r⚡ 同步中: [${Math.min(100, percent).toFixed(1)}%] | 当前区块: ${cursor} | 新增交易: ${newCount}`);
        
        // 💾 每处理完一批并发，就存一次档，确保进度不丢失
        saveData();
    }

    console.log(`\n✅ 历史数据已同步。切换至实时监控模式。`);
    isSyncing = false;
    startLiveMonitor();
}

// 🎥 实时监控
function startLiveMonitor() {
    // 这里的起点就是我们刚才同步结束的地方
    let lastVersion = scanProgressHeight;
    
    setInterval(async () => {
        try {
            const info = await endless.getLedgerInfo();
            const chainTip = BigInt(info.ledger_version);
            currentChainHeight = chainTip;

            // 只有当链上有新区块时才抓取
            if (chainTip > lastVersion) {
                // 每次抓一小批
                const txs = await fetchBatchWithRetry(lastVersion, 50);
                
                let hasUpdate = false;
                let maxVerInBatch = lastVersion;

                for (const tx of txs) {
                    const ver = BigInt(tx.version);
                    if (ver > maxVerInBatch) maxVerInBatch = ver;

                    const record = parseTx(tx);
                    if (record && !processedVersions.has(record.version)) {
                        processedVersions.add(record.version);
                        allTransactions.push(record);
                        hasUpdate = true;
                        console.log(`\n🔥 新交易 [Block:${ver}] 用户 ${record.sender.slice(0,6)}... +${record.buyAmount} / -${record.sellAmount}`);
                    }
                }
                
                // 推进进度
                if (txs.length > 0) {
                    lastVersion = maxVerInBatch + 1n;
                } else {
                    // 如果没抓到交易，但链高度确实增加了，说明是空块，直接跳过
                    // 安全起见，一次只跳 50 个，防止漏掉
                    if (chainTip > lastVersion + 50n) {
                        lastVersion += 50n;
                    } else {
                        lastVersion = chainTip;
                    }
                }

                // 更新全局进度并存档
                scanProgressHeight = lastVersion;
                if (hasUpdate || scanProgressHeight % 100n === 0n) { // 有更新或每过100个块存一次
                    saveData();
                }
            }
        } catch (e) { }
    }, 2000);
}

// === API ===
app.get('/api/leaderboard', (req, res) => {
    const startTime = parseInt(req.query.start as string) || 0;
    const endTime = parseInt(req.query.end as string) || Date.now();

    const filteredTxs = allTransactions.filter(tx => 
        tx.timestamp >= startTime && tx.timestamp <= endTime
    );

    const leaderboardMap: Record<string, any> = {};
    
    filteredTxs.forEach(tx => {
        const addr = tx.sender;
        if (!leaderboardMap[addr]) {
            leaderboardMap[addr] = { 
                address: addr, totalVolume: 0, buyVolume: 0, sellVolume: 0, txCount: 0 
            };
        }
        leaderboardMap[addr].buyVolume += tx.buyAmount;
        leaderboardMap[addr].sellVolume += tx.sellAmount;
        leaderboardMap[addr].totalVolume += (tx.buyAmount + tx.sellAmount);
        leaderboardMap[addr].txCount += 1;
    });

    const list = Object.values(leaderboardMap).sort((a:any, b:any) => b.totalVolume - a.totalVolume);

    res.json({
        updatedAt: Date.now(),
        blockHeight: currentChainHeight.toString(),
        totalTransactions: filteredTxs.length,
        totalTraders: list.length,
        top100: list.slice(0, 100),
        status: isSyncing ? "syncing" : "live"
    });
});

app.listen(3001, () => {
    console.log("🌐 后端服务运行中: http://localhost:3001");
    fastSync();
});