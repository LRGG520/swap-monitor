import { Endless, EndlessConfig, Network } from "@endlesslab/endless-ts-sdk";

// ==========================================
// 🔴 您的钱包地址 (已自动填入)
const MY_WALLET_ADDRESS = "Dr8KKYwjTcKzpMquGMtKdX5MxJaQHjpNjY1TYwWoEmee"; 
// ==========================================

const RPC_NODE_URL = "https://rpc.endless.link/v1";
// 实例化配置
const config = new EndlessConfig({ 
    fullnode: RPC_NODE_URL, 
    network: Network.MAINNET 
});
const endless = new Endless(config);

async function spyOnMyTransaction() {
    console.clear();
    console.log(`🕵️‍♂️ 侦探模式已启动...`);
    console.log(`👀 正在监控地址: ${MY_WALLET_ADDRESS}`);
    console.log(`⏳ 请现在去 SliSwap 官网做一笔 EDS 交易...`);

    let lastScannedVersion = 0n;

    // 1. 获取当前链的高度，作为起点
    try {
        const info = await endless.getLedgerInfo();
        lastScannedVersion = BigInt(info.ledger_version);
        console.log(`✅ 网络连接正常 (高度: ${lastScannedVersion})`);
    } catch(e) { 
        console.error("❌ 网络连接失败，请检查 VPN 或网络设置"); 
        return; 
    }

    // 2. 开启循环扫描
    setInterval(async () => {
        try {
            // 获取全网最新的 20 笔交易
            const txs = await endless.getTransactions({
                options: { limit: 20 } 
            });
            
            for (const tx of txs) {
                // 只看用户交易
                if (tx.type === 'user_transaction') {
                    // 核心：比对发送者地址 (忽略大小写)
                    if (tx.sender === MY_WALLET_ADDRESS) {
                        
                        // 必须是新产生的交易
                        if (BigInt(tx.version) > lastScannedVersion) {
                            console.log("\n\n🚨🚨🚨 抓到了！捕获到您的交易！ 🚨🚨🚨");
                            console.log("===========================================");
                            console.log(`Version: ${tx.version}`);
                            console.log(`Hash: ${tx.hash}`);
                            console.log("-------------------------------------------");
                            console.log("【请复制下面这对括号及其中间的所有内容发给我】:\n");
                            
                            const events = tx.events || [];
                            // 打印完整的 JSON
                            console.log(JSON.stringify(events, null, 2));
                            
                            console.log("\n===========================================");
                            console.log("✅ 侦测结束。");
                            
                            // 更新高度防止重复打印
                            lastScannedVersion = BigInt(tx.version);
                            // 也可以选择抓到一次就退出: process.exit(0);
                        }
                    }
                }
            }
            
            // 简单的防卡死更新：如果全网交易很多，更新扫描基准线
            if (txs.length > 0) {
                 const maxVer = BigInt(txs[0].version);
                 // 只有当最新高度远大于上次扫描高度时才跟进，避免漏掉刚发生的交易
                 if (maxVer > lastScannedVersion + 100n) {
                     lastScannedVersion = maxVer - 50n; // 保持 50 个区块的缓冲区
                 }
            }

        } catch (e) {
            // 忽略偶尔的网络请求错误
        }
    }, 1000); // 每秒扫描一次
}

spyOnMyTransaction();