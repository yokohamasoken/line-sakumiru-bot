/**
 * LINE → サクミル 自動連携bot
 *
 * 動作:
 * 1. LINEからWebhookを受信
 * 2. メッセージから案件情報を正規表現で抽出
 * 3. Firebase AuthでサクミルAPIにログイン
 * 4. GraphQL mutationで案件を自動登録
 * 5. 結果をLINEに返信
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';

// ========== 設定 ==========
const CONFIG = {
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || 'beb207f96406bfa478e8579d69f94dfb',
  LINE_ACCESS_TOKEN: process.env.LINE_ACCESS_TOKEN || 'hVfG57fK82xU0mWB1nMcNr0EZgl3j3Ox55DNmJaFW9Xqes5UFIqt2mqn2t2TZk+xrXaJKjWes4BIvyqUDdFZ2C1ILGsyEiVtvKf0WIQGv7XXJZJiLH4ATsS7DeAV/B91H2pVahMslT/9FeCcetJt6AdB04t89/1O/w1cDnyilFU=',
  PORT: process.env.PORT || 3000,
  SAKUMIRU_EMAIL: process.env.SAKUMIRU_EMAIL || '',
  SAKUMIRU_PASSWORD: process.env.SAKUMIRU_PASSWORD || '',
  // Firebase設定（サクミル公式アプリから取得）
  FIREBASE_API_KEY: 'AIzaSyB8TDAB-ykHb3JxYbJQr3Q15Xq0hNeXJwg',
  // サクミル組織・ステータス設定（初回起動時に自動取得）
  SAKUMIRU_ORG_ID: null,
  SAKUMIRU_DEFAULT_ASSIGNEE_ID: null,
  SAKUMIRU_DEFAULT_STATUS_ID: null,
  // キャッシュ
  _idToken: null,
  _idTokenExpiry: 0,
};

// ========== LINEシグネチャ検証 ==========
function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', CONFIG.LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// ========== HTTPSリクエストヘルパー ==========
function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      ...headers
    };
    if (data) h['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ hostname, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ========== Firebase認証（トークンキャッシュ付き）==========
async function getFirebaseToken() {
  const now = Date.now();
  // トークンが有効（残り5分以上）であればキャッシュを使用
  if (CONFIG._idToken && CONFIG._idTokenExpiry - now > 5 * 60 * 1000) {
    return CONFIG._idToken;
  }

  console.log('[Firebase] ログイン中...');
  const res = await httpsRequest(
    'POST',
    'identitytoolkit.googleapis.com',
    `/v1/accounts:signInWithPassword?key=${CONFIG.FIREBASE_API_KEY}`,
    {},
    { email: CONFIG.SAKUMIRU_EMAIL, password: CONFIG.SAKUMIRU_PASSWORD, returnSecureToken: true }
  );

  if (!res.body.idToken) {
    throw new Error('Firebase認証失敗: ' + JSON.stringify(res.body));
  }

  CONFIG._idToken = res.body.idToken;
  // expiresIn は秒単位（通常3600秒 = 1時間）
  CONFIG._idTokenExpiry = now + (parseInt(res.body.expiresIn || '3600') * 1000);
  console.log('[Firebase] ログイン成功');
  return CONFIG._idToken;
}

// ========== GraphQL ==========
async function graphql(idToken, query, variables) {
  const res = await httpsRequest(
    'POST',
    'api.sakumiru.jp',
    '/graphql',
    {
      'Authorization': `Bearer ${idToken}`,
      'Origin': 'https://pc.sakumiru.jp',
      'Referer': 'https://pc.sakumiru.jp/',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
    },
    { query, variables }
  );

  if (res.body.errors) {
    const errMsg = res.body.errors.map(e => e.message).join('; ');
    throw new Error('GraphQL Error: ' + errMsg);
  }
  return res.body.data;
}

// ========== サクミル初期設定取得 ==========
async function initSakumiru() {
  if (CONFIG.SAKUMIRU_ORG_ID) return; // 既に初期化済み

  if (!CONFIG.SAKUMIRU_EMAIL || !CONFIG.SAKUMIRU_PASSWORD) {
    console.warn('[サクミル] メール/パスワードが未設定です');
    return;
  }

  try {
    const idToken = await getFirebaseToken();
    const data = await graphql(idToken, `{
      viewer {
        id
        organization {
          id
          projectStatuses { nodes { id name } }
          memberships { nodes { id fullName } }
        }
      }
    }`);

    const org = data.viewer.organization;
    CONFIG.SAKUMIRU_ORG_ID = org.id;

    // ログインユーザー自身をデフォルト担当者に
    CONFIG.SAKUMIRU_DEFAULT_ASSIGNEE_ID = data.viewer.id;

    // 「新規」ステータスを探す（なければ最初のステータス）
    const newStatus = org.projectStatuses.nodes.find(s => s.name === '新規') || org.projectStatuses.nodes[0];
    CONFIG.SAKUMIRU_DEFAULT_STATUS_ID = newStatus?.id;

    console.log('[サクミル] 初期化完了');
    console.log('  組織ID:', CONFIG.SAKUMIRU_ORG_ID);
    console.log('  担当者ID:', CONFIG.SAKUMIRU_DEFAULT_ASSIGNEE_ID);
    console.log('  ステータスID:', CONFIG.SAKUMIRU_DEFAULT_STATUS_ID, `(${newStatus?.name})`);
  } catch (e) {
    console.error('[サクミル] 初期化エラー:', e.message);
  }
}

// ========== LINEへ返信 ==========
async function replyToLine(replyToken, text) {
  return httpsRequest(
    'POST',
    'api.line.me',
    '/v2/bot/message/reply',
    { Authorization: `Bearer ${CONFIG.LINE_ACCESS_TOKEN}` },
    { replyToken, messages: [{ type: 'text', text }] }
  );
}

// ========== LINE プッシュ通知（管理者へ）==========
async function pushToAdmin(text) {
  const adminId = process.env.ADMIN_LINE_USER_ID;
  if (!adminId) return;
  return httpsRequest(
    'POST',
    'api.line.me',
    '/v2/bot/message/push',
    { Authorization: `Bearer ${CONFIG.LINE_ACCESS_TOKEN}` },
    { to: adminId, messages: [{ type: 'text', text }] }
  );
}

// ========== 案件情報の抽出 ==========
function extractProjectInfo(text) {
  const info = {
    住所: null,
    金額: null,
    工事内容: null,
    工期開始: null,
    工期終了: null,
    顧客名: null,
    備考: text,
  };

  // 住所パターン（市区町村 + 番地）
  const addrMatch = text.match(/(神奈川県|東京都|埼玉県|千葉県|静岡県|山梨県|茨城県)?[\u4e00-\u9fff]{2,6}[市区町村][\u4e00-\u9fff\d\-－〜～ー]+\d+[-－]\d+(?:[-－]\d+)?/);
  if (addrMatch) info.住所 = addrMatch[0];

  // 金額パターン（○○万円）
  const amtMatch = text.match(/(\d{1,4})[,，]?(\d{0,3})\s*万円/);
  if (amtMatch) info.金額 = amtMatch[0];

  // 工期パターン
  const periodMatch = text.match(/(\d{1,2}[\/月]\d{1,2}日?)\s*[〜～~\-]\s*(\d{1,2}[\/月]\d{1,2}日?)/);
  if (periodMatch) {
    info.工期開始 = periodMatch[1];
    info.工期終了 = periodMatch[2];
  }

  // 工事内容パターン
  const workMatch = text.match(/(木造|RC造|鉄骨造|軽量鉄骨|RC|解体|撤去|外構|内装|基礎)[^\n、。]{0,30}/);
  if (workMatch) info.工事内容 = workMatch[0];

  return info;
}

// ========== 案件名の生成 ==========
function buildProjectName(info, senderName) {
  const parts = [];
  if (info.住所) parts.push(info.住所);
  if (info.工事内容) parts.push(info.工事内容);
  if (senderName) parts.push(`(${senderName})`);
  return parts.join(' ') || `LINE受信案件 ${new Date().toLocaleDateString('ja-JP')}`;
}

// ========== サクミルへの案件登録 ==========
async function registerToSakumiru(projectInfo, senderName) {
  if (!CONFIG.SAKUMIRU_ORG_ID) {
    return { success: false, message: 'サクミル未初期化（環境変数SAKUMIRU_EMAIL/PASSWORDを確認）' };
  }

  try {
    const idToken = await getFirebaseToken();
    const projectName = buildProjectName(projectInfo, senderName);

    const data = await graphql(idToken, `
      mutation PcProjectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          project { id name }
        }
      }
    `, {
      input: {
        organizationId: CONFIG.SAKUMIRU_ORG_ID,
        name: projectName,
        assigneeIds: [CONFIG.SAKUMIRU_DEFAULT_ASSIGNEE_ID],
        projectStatusId: CONFIG.SAKUMIRU_DEFAULT_STATUS_ID,
        // 備考欄に元メッセージを保存
        memo: projectInfo.備考 || '',
      }
    });

    const project = data.projectCreate.project;
    console.log('[サクミル] 案件登録成功:', project.id, project.name);
    return { success: true, projectId: project.id, projectName: project.name };
  } catch (e) {
    console.error('[サクミル] 登録エラー:', e.message);
    return { success: false, message: e.message };
  }
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
  const projectInfo = extractProjectInfo(text);

  // サクミルに登録
  const result = await registerToSakumiru(projectInfo, null);

  // 返信メッセージ作成
  const lines = ['📋 案件情報を受け取りました', ''];
  if (projectInfo.住所) lines.push(`📍 住所: ${projectInfo.住所}`);
  if (projectInfo.工事内容) lines.push(`🔨 工事: ${projectInfo.工事内容}`);
  if (projectInfo.金額) lines.push(`💴 金額: ${projectInfo.金額}`);
  if (projectInfo.工期開始) lines.push(`📅 工期: ${projectInfo.工期開始}〜${projectInfo.工期終了 || ''}`);
  lines.push('');

  if (result.success) {
    lines.push(`✅ サクミルに登録しました`);
    lines.push(`📝 案件名: ${result.projectName}`);
  } else {
    lines.push(`⚠️ サクミル登録エラー: ${result.message}`);
  }

  await replyToLine(replyToken, lines.filter(Boolean).join('\n'));

  // 管理者（工藤さん）へのプッシュ通知
  if (result.success) {
    const senderLabel = userId ? `送信者: ${userId}` : '';
    const adminMsg = [
      '🔔 新規案件がサクミルに登録されました',
      '',
      `📝 案件名: ${result.projectName}`,
      projectInfo.住所 ? `📍 住所: ${projectInfo.住所}` : '',
      projectInfo.金額 ? `💴 金額: ${projectInfo.金額}` : '',
      projectInfo.工期開始 ? `📅 工期: ${projectInfo.工期開始}〜${projectInfo.工期終了 || ''}` : '',
      senderLabel,
    ].filter(Boolean).join('\n');
    await pushToAdmin(adminMsg).catch(e => console.error('[Push] 管理者通知失敗:', e.message));
  }
}

// ========== HTTPサーバー ==========
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('LINE → サクミル bot 稼働中 ✅');
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const signature = req.headers['x-line-signature'];
      if (!verifySignature(body, signature)) {
        console.warn('[Webhook] シグネチャ検証失敗');
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
        console.error('[Webhook] 処理エラー:', e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// 起動時にサクミル初期化
initSakumiru().then(() => {
  server.listen(CONFIG.PORT, () => {
    console.log(`🚀 LINE → サクミル bot 起動`);
    console.log(`📡 Port: ${CONFIG.PORT}`);
    console.log(`🔗 Webhook: /webhook`);
  });
});
