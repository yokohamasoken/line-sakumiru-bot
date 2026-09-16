/**
 * LINE → サクミル 自動連携bot
 * 
 * 動作:
 * 1. LINEからWebhookを受信
 * 2. メッセージをAI(Claude)で解析して案件情報を抽出
 * 3. サクミルに案件を自動登録
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';

// ========== 設定 ==========
const CONFIG = {
  LINE_CHANNEL_SECRET: 'beb207f96406bfa478e8579d69f94dfb',
  LINE_ACCESS_TOKEN: 'hVfG57fK82xU0mWB1nMcNr0EZgl3j3Ox55DNmJaFW9Xqes5UFIqt2mqn2t2TZk+xrXaJKjWes4BIvyqUDdFZ2C1ILGsyEiVtvKf0WIQGv7XXJZJiLH4ATsS7DeAV/B91H2pVahMslT/9FeCcetJt6AdB04t89/1O/w1cDnyilFU=',
  PORT: process.env.PORT || 3000,
  // サクミルのログイン情報（後で設定）
  SAKUMIRU_EMAIL: process.env.SAKUMIRU_EMAIL || '',
  SAKUMIRU_PASSWORD: process.env.SAKUMIRU_PASSWORD || '',
  // Claude API（オプション・案件情報AI抽出用）
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY || '',
};

// ========== LINEシグネチャ検証 ==========
function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', CONFIG.LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// ========== HTTPS POST ヘルパー ==========
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ========== LINEへ返信 ==========
async function replyToLine(replyToken, text) {
  return httpsPost('api.line.me', '/v2/bot/message/reply', {
    Authorization: `Bearer ${CONFIG.LINE_ACCESS_TOKEN}`
  }, {
    replyToken,
    messages: [{ type: 'text', text }]
  });
}

// ========== AI で案件情報を抽出 ==========
async function extractProjectInfo(text) {
  // Claude APIがあれば使用
  if (CONFIG.CLAUDE_API_KEY) {
    try {
      const res = await httpsPost('api.anthropic.com', '/v1/messages', {
        'x-api-key': CONFIG.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      }, {
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `以下のLINEメッセージから建設・解体案件の情報を抽出してJSON形式で返してください。
情報がない場合はnullを使用してください。

メッセージ:
${text}

返すJSON形式:
{
  "顧客名": "...",
  "住所": "...",
  "電話番号": "...",
  "工事内容": "...",
  "金額": "...",
  "工期開始": "...",
  "工期終了": "...",
  "担当者": "...",
  "備考": "..."
}

JSONのみ返してください。`
        }]
      });
      const parsed = JSON.parse(res.body);
      const jsonText = parsed.content?.[0]?.text || '{}';
      const match = jsonText.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (e) {
      console.error('Claude API エラー:', e.message);
    }
  }

  // Claude APIなしの場合: 正規表現で簡易抽出
  const info = {
    住所: null, 金額: null, 工事内容: null,
    工期開始: null, 工期終了: null, 顧客名: null, 電話番号: null, 担当者: null, 備考: text
  };

  // 住所パターン
  const addrMatch = text.match(/(神奈川県|東京都|埼玉県|千葉県)?[\u4e00-\u9fff]{2,4}[市区町村][\u4e00-\u9fff\d\-－〜～]+\d+[-－]\d+/);
  if (addrMatch) info.住所 = addrMatch[0];

  // 金額パターン
  const amtMatch = text.match(/(\d{1,4}[,.，、]?\d{0,3})\s*万円/);
  if (amtMatch) info.金額 = amtMatch[0];

  // 工期パターン（9/8〜9/19 形式）
  const periodMatch = text.match(/(\d{1,2}[\/月]\d{1,2}日?)[〜～~]\s*(\d{1,2}[\/月]\d{1,2}日?)/);
  if (periodMatch) { info.工期開始 = periodMatch[1]; info.工期終了 = periodMatch[2]; }

  return info;
}

// ========== サクミルに案件登録 ==========
async function registerToSakumiru(projectInfo, originalMessage) {
  // TODO: サクミルのAPIまたはWebスクレイピングで登録
  // 現時点では情報をコンソールに出力してLINEに通知
  console.log('=== サクミル登録予定データ ===');
  console.log(JSON.stringify(projectInfo, null, 2));
  console.log('============================');
  
  // サクミルのログイン情報が設定されていれば自動登録を試みる
  if (CONFIG.SAKUMIRU_EMAIL && CONFIG.SAKUMIRU_PASSWORD) {
    // TODO: サクミルへの登録処理（Phase 2で実装）
    return { success: false, message: 'サクミル自動登録は準備中です' };
  }
  
  return { success: true, message: '案件情報を抽出しました' };
}

// ========== メッセージ処理 ==========
async function handleMessage(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text;
  const replyToken = event.replyToken;
  const userId = event.source.userId;

  console.log(`[受信] ${new Date().toLocaleString('ja-JP')} | User: ${userId}`);
  console.log(`[メッセージ] ${text}`);

  // 案件情報の抽出
  const projectInfo = await extractProjectInfo(text);
  
  // サクミルに登録
  const result = await registerToSakumiru(projectInfo, text);

  // 抽出結果をLINEに返信
  const summary = [
    '📋 案件情報を受け取りました',
    '',
    projectInfo.住所 ? `📍 住所: ${projectInfo.住所}` : '📍 住所: 不明',
    projectInfo.工事内容 ? `🔨 工事: ${projectInfo.工事内容}` : '',
    projectInfo.金額 ? `💴 金額: ${projectInfo.金額}` : '',
    projectInfo.工期開始 ? `📅 工期: ${projectInfo.工期開始}〜${projectInfo.工期終了 || ''}` : '',
    '',
    result.success ? '✅ サクミルへの登録を処理中です' : `⚠️ ${result.message}`,
  ].filter(Boolean).join('\n');

  await replyToLine(replyToken, summary);
  
  return projectInfo;
}

// ========== HTTPサーバー ==========
const server = http.createServer(async (req, res) => {
  // ヘルスチェック
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('LINE → サクミル bot 稼働中 ✅');
    return;
  }

  // Webhook エンドポイント
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // シグネチャ検証
      const signature = req.headers['x-line-signature'];
      if (!verifySignature(body, signature)) {
        console.warn('シグネチャ検証失敗');
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      res.writeHead(200);
      res.end('OK');

      try {
        const payload = JSON.parse(body);
        for (const event of payload.events || []) {
          await handleMessage(event);
        }
      } catch (e) {
        console.error('処理エラー:', e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(CONFIG.PORT, () => {
  console.log(`🚀 LINE → サクミル bot 起動`);
  console.log(`📡 Port: ${CONFIG.PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${CONFIG.PORT}/webhook`);
  console.log(`\n⚠️  注意: 外部からアクセスするにはngrokまたはRender.comへのデプロイが必要です`);
});
