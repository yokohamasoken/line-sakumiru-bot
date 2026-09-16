/**
 * LINE → サクミル 自動連携bot
 *
 * 動作:
 * 1. LINEからWebhookを受信
 * 2. テキスト → 案件情報抽出 → サクミル案件登録 → 返信＋管理者通知
 * 3. 画像 → 直前の案件 or #番号指定の案件フォルダに写真アップロード
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
  FIREBASE_API_KEY: 'AIzaSyB8TDAB-ykHb3JxYbJQr3Q15Xq0hNeXJwg',
  SAKUMIRU_ORG_ID: null,
  SAKUMIRU_DEFAULT_ASSIGNEE_ID: null,
  SAKUMIRU_DEFAULT_STATUS_ID: null,
  _idToken: null,
  _idTokenExpiry: 0,
};

// ユーザーごとの最後の案件を記憶（メモリ内）
// { userId: { projectId, projectName, expiry } }
const userLastProject = new Map();

// ========== 送信者名 → サクミル顧客IDマッピング ==========
const SENDER_CLIENT_MAP = [
  { keywords: ['一梧works', '一梧', 'ichigo', '原田真司', '原田'], clientId: 'Z2lkOi8vYXBpL0NsaWVudC82ODAwNDA' }, // 株式会社一梧works
  { keywords: ['三心', 'sanshin', '現場発注三心'], clientId: 'Z2lkOi8vYXBpL0NsaWVudC82ODAzOTc' }, // 三心建設
  { keywords: ['shell forest', 'シェルフォレスト', '現場発注shell', '島田一樹', '島田', 'shimada'], clientId: 'Z2lkOi8vYXBpL0NsaWVudC82ODIxNTU' }, // shell forest
  { keywords: ['峯尾', 'みねお', 'mineo'], clientId: 'Z2lkOi8vYXBpL0NsaWVudC82ODU5MzA' }, // 株式会社 BEN.MINE
  { keywords: ['佐藤', 'さとう', 'sato'], clientId: 'Z2lkOi8vYXBpL0NsaWVudC83NDcwODk' }, // 株式会社トライコーポレーション
];

function getClientIdFromSenderName(displayName) {
  if (!displayName) return null;
  const lower = displayName.toLowerCase();
  for (const entry of SENDER_CLIENT_MAP) {
    if (entry.keywords.some(k => lower.includes(k.toLowerCase()))) return entry.clientId;
  }
  return null;
}

// ========== LINEシグネチャ検証 ==========
function verifySignature(body, signature) {
  const hash = crypto.createHmac('SHA256', CONFIG.LINE_CHANNEL_SECRET).update(body).digest('base64');
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

// ========== バイナリHTTPSダウンロード ==========
function httpsDownload(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = new URL(res.headers.location);
        return resolve(httpsDownload(loc.hostname, loc.pathname + (loc.search || ''), headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || 'image/jpeg',
        buffer: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ========== Firebase認証 ==========
async function getFirebaseToken() {
  const now = Date.now();
  if (CONFIG._idToken && CONFIG._idTokenExpiry - now > 5 * 60 * 1000) return CONFIG._idToken;
  console.log('[Firebase] ログイン中...');
  const res = await httpsRequest('POST', 'identitytoolkit.googleapis.com',
    `/v1/accounts:signInWithPassword?key=${CONFIG.FIREBASE_API_KEY}`,
    {}, { email: CONFIG.SAKUMIRU_EMAIL, password: CONFIG.SAKUMIRU_PASSWORD, returnSecureToken: true });
  if (!res.body.idToken) throw new Error('Firebase認証失敗: ' + JSON.stringify(res.body));
  CONFIG._idToken = res.body.idToken;
  CONFIG._idTokenExpiry = now + (parseInt(res.body.expiresIn || '3600') * 1000);
  console.log('[Firebase] ログイン成功');
  return CONFIG._idToken;
}

// ========== GraphQL ==========
async function graphql(idToken, query, variables) {
  const res = await httpsRequest('POST', 'api.sakumiru.jp', '/graphql', {
    'Authorization': `Bearer ${idToken}`,
    'Origin': 'https://pc.sakumiru.jp',
    'Referer': 'https://pc.sakumiru.jp/',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
  }, { query, variables });
  if (res.body.errors) throw new Error('GraphQL Error: ' + res.body.errors.map(e => e.message).join('; '));
  return res.body.data;
}

// ========== GraphQL multipart upload（写真アップロード用）==========
function graphqlUpload(idToken, query, variables, fileBuffer, contentType, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
    const operationsJSON = JSON.stringify({ query, variables });
    const mapJSON = JSON.stringify({ '0': ['variables.input.file'] });

    const parts = [];
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="operations"\r\n\r\n${operationsJSON}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="map"\r\n\r\n${mapJSON}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="0"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    );
    const partsBuffer = Buffer.from(parts.join(''), 'utf8');
    const endBuffer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const bodyBuffer = Buffer.concat([partsBuffer, fileBuffer, endBuffer]);

    const req = https.request({
      hostname: 'api.sakumiru.jp', path: '/graphql', method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length,
        'Authorization': `Bearer ${idToken}`,
        'Origin': 'https://pc.sakumiru.jp',
        'Referer': 'https://pc.sakumiru.jp/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
      }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          if (json.errors) reject(new Error(json.errors.map(e => e.message).join('; ')));
          else resolve(json.data);
        } catch (e) { reject(new Error('Parse error: ' + buf.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

// ========== サクミル初期化 ==========
async function initSakumiru() {
  if (CONFIG.SAKUMIRU_ORG_ID) return;
  if (!CONFIG.SAKUMIRU_EMAIL || !CONFIG.SAKUMIRU_PASSWORD) { console.warn('[サクミル] 認証情報未設定'); return; }
  try {
    const idToken = await getFirebaseToken();
    const data = await graphql(idToken, `{ viewer { id organization { id projectStatuses { nodes { id name } } memberships { nodes { id fullName deactivatedAt } } } } }`);
    const org = data.viewer.organization;
    CONFIG.SAKUMIRU_ORG_ID = org.id;
    // 有効な「工藤」メンバーシップをデフォルト担当者に（無効なviewer IDを回避）
    const kudo = org.memberships.nodes.find(m => m.fullName === '工藤' && !m.deactivatedAt);
    CONFIG.SAKUMIRU_DEFAULT_ASSIGNEE_ID = kudo?.id || data.viewer.id;
    console.log('[サクミル] デフォルト担当者:', kudo?.fullName || '(viewer)', CONFIG.SAKUMIRU_DEFAULT_ASSIGNEE_ID);
    const newStatus = org.projectStatuses.nodes.find(s => s.name === '新規') || org.projectStatuses.nodes[0];
    CONFIG.SAKUMIRU_DEFAULT_STATUS_ID = newStatus?.id;
    console.log('[サクミル] 初期化完了 org:', CONFIG.SAKUMIRU_ORG_ID, 'status:', newStatus?.name);
  } catch (e) { console.error('[サクミル] 初期化エラー:', e.message); }
}

// ========== LINE返信・通知 ==========
async function replyToLine(replyToken, text) {
  return httpsRequest('POST', 'api.line.me', '/v2/bot/message/reply',
    { Authorization: `Bearer ${CONFIG.LINE_ACCESS_TOKEN}` },
    { replyToken, messages: [{ type: 'text', text }] });
}

async function pushToAdmin(text) {
  const adminId = process.env.ADMIN_LINE_USER_ID;
  if (!adminId) return;
  return httpsRequest('POST', 'api.line.me', '/v2/bot/message/push',
    { Authorization: `Bearer ${CONFIG.LINE_ACCESS_TOKEN}` },
    { to: adminId, messages: [{ type: 'text', text }] });
}

// ========== 案件情報の抽出 ==========
// ========== 案件種別マッピング ==========
const CATEGORY_MAP = [
  { keywords: ['木造.*三階', '木造.*3階', '木造3', 'w造.*三階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU0OA', name: '木造三階解体工事' },
  { keywords: ['木造.*二階', '木造.*2階', '木造2', 'w造.*二階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MTk2Ng', name: '木造二階解体工事' },
  { keywords: ['木造.*平屋', '木造.*1階', 'w造.*平屋'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU0Nw', name: '木造平屋解体工事' },
  { keywords: ['RC.*5階', 'RC.*五階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU1NA', name: 'RC ５階解体工事' },
  { keywords: ['RC.*4階', 'RC.*四階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MTk2OQ', name: 'RC ４階解体工事' },
  { keywords: ['RC.*3階', 'RC.*三階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MTk2OA', name: 'RC ３階解体工事' },
  { keywords: ['RC.*2階', 'RC.*二階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MTk2Nw', name: 'RC 2階解体工事' },
  { keywords: ['RC.*平屋', 'RC.*1階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU0OQ', name: 'RC 平屋階解体工事' },
  { keywords: ['軽鉄.*3階', '軽鉄.*三階', '軽量鉄骨.*3', 'lfr.*3'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU1Ng', name: '軽鉄３階解体工事' },
  { keywords: ['軽鉄.*2階', '軽鉄.*二階', '軽量鉄骨.*2'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU1NQ', name: '軽鉄２階解体工事' },
  { keywords: ['軽鉄.*平屋', '軽量鉄骨.*平屋', '軽鉄.*1階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MzA1NA', name: '軽鉄平屋解体工事' },
  { keywords: ['鉄骨.*3階', '鉄骨.*三階', 'S造.*3'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81NTg5Nw', name: '鉄骨3階解体工事' },
  { keywords: ['鉄骨.*2階', '鉄骨.*二階', 'S造.*2'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81NTg5Ng', name: '鉄骨2階解体工事' },
  { keywords: ['鉄骨.*1階', '鉄骨.*平屋', 'S造.*1'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81NTg5OA', name: '鉄骨1階解体工事' },
  { keywords: ['鉄骨ALC.*4', 'ALC.*4階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU1Mw', name: '鉄骨ALC4階解体工事' },
  { keywords: ['鉄骨ALC.*3', 'ALC.*3階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU1Mg', name: '鉄骨ALC3階解体工事' },
  { keywords: ['鉄骨ALC.*2', 'ALC.*2階'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU1MQ', name: '鉄骨ALC2階解体工事' },
  { keywords: ['鉄骨ALC.*平屋', 'ALC.*平屋'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjU1MA', name: '鉄骨ALC平屋解体工事' },
  { keywords: ['基礎杭', '杭撤去'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81NDIwNA', name: '基礎杭撤去工事' },
  { keywords: ['残置物', '残置'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS82OTU3MQ', name: '残置物撤去' },
  { keywords: ['外構'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjQ0MQ', name: '外構工事' },
  { keywords: ['リフォーム', '内装'], id: 'Z2lkOi8vYXBpL1Byb2plY3RDYXRlZ29yeS81MjA5Ng', name: 'リフォーム工事' },
];

function getCategoryFromText(text) {
  const t = text.replace(/\s/g, '');
  for (const cat of CATEGORY_MAP) {
    for (const kw of cat.keywords) {
      if (new RegExp(kw, 'i').test(t)) return cat;
    }
  }
  return null;
}

// ========== 日付パース（ISO8601に変換）==========
function parseJapaneseDate(str) {
  if (!str) return null;
  // 年が含まれない場合は今年 or 来年を補完
  const now = new Date();
  let year = now.getFullYear();
  // 月/日 or 月月日 形式
  const m = str.match(/(\d{1,2})[\/月](\d{1,2})/);
  if (!m) return null;
  const month = parseInt(m[1]);
  const day = parseInt(m[2]);
  // 月が現在より前なら来年
  if (month < now.getMonth() + 1 || (month === now.getMonth() + 1 && day < now.getDate())) {
    year += 1;
  }
  const d = new Date(year, month - 1, day, 9, 0, 0);
  return d.toISOString();
}

// ========== 案件情報の抽出 ==========
function extractProjectInfo(text) {
  const info = { 住所: null, 金額: null, 工事内容: null, 工期開始: null, 工期終了: null, 工期開始ISO: null, 工期終了ISO: null, categoryId: null, categoryName: null };
  const addrMatch = text.match(/(神奈川県|東京都|埼玉県|千葉県|静岡県|山梨県|茨城県)?[\u4e00-\u9fff]{2,6}[市区町村][\u4e00-\u9fff\d\-－〜～ー]+\d+[-－]\d+(?:[-－]\d+)?/);
  if (addrMatch) info.住所 = addrMatch[0];
  const amtMatch = text.match(/(\d{1,4})[,，]?(\d{0,3})\s*万円/);
  if (amtMatch) info.金額 = amtMatch[0];
  const periodMatch = text.match(/(\d{1,2}[\/月]\d{1,2}日?)\s*[〜～~\-]\s*(\d{1,2}[\/月]\d{1,2}日?)/);
  if (periodMatch) {
    info.工期開始 = periodMatch[1];
    info.工期終了 = periodMatch[2];
    info.工期開始ISO = parseJapaneseDate(periodMatch[1]);
    info.工期終了ISO = parseJapaneseDate(periodMatch[2]);
  }
  const workMatch = text.match(/(木造|RC造|鉄骨造|軽量鉄骨|RC|解体|撤去|外構|内装|基礎|軽鉄)[^\n、。]{0,30}/);
  if (workMatch) info.工事内容 = workMatch[0];
  // 案件種別自動判定
  const cat = getCategoryFromText(text);
  if (cat) { info.categoryId = cat.id; info.categoryName = cat.name; }
  return info;
}

// ========== LINE ユーザー表示名を取得 ==========
async function getLineDisplayName(userId) {
  try {
    const res = await httpsRequest('GET', 'api.line.me', `/v2/bot/profile/${userId}`,
      { Authorization: `Bearer ${CONFIG.LINE_ACCESS_TOKEN}` }, null);
    return res.body.displayName || null;
  } catch (e) {
    console.error('[LINE] 表示名取得失敗:', e.message);
    return null;
  }
}

// ========== 案件登録 ==========
async function registerToSakumiru(projectInfo, userId, displayName) {
  if (!CONFIG.SAKUMIRU_ORG_ID) return { success: false, message: 'サクミル未初期化' };
  try {
    const idToken = await getFirebaseToken();
    const parts = [];
    if (projectInfo.住所) parts.push(projectInfo.住所);
    if (projectInfo.工事内容) parts.push(projectInfo.工事内容);
    const projectName = parts.join(' ') || `LINE受信案件 ${new Date().toLocaleDateString('ja-JP')}`;

    // 送信者名から顧客IDを自動判定
    const clientId = getClientIdFromSenderName(displayName);
    if (clientId) console.log(`[サクミル] 顧客自動設定: ${displayName} → ${clientId}`);

    const input = {
      organizationId: CONFIG.SAKUMIRU_ORG_ID,
      name: projectName,
      assigneeIds: [CONFIG.SAKUMIRU_DEFAULT_ASSIGNEE_ID],
      projectStatusId: CONFIG.SAKUMIRU_DEFAULT_STATUS_ID,
    };
    if (clientId) input.clientId = clientId;
    if (projectInfo.工期開始ISO) input.startAt = projectInfo.工期開始ISO;
    if (projectInfo.工期終了ISO) input.endAt = projectInfo.工期終了ISO;
    if (projectInfo.categoryId) input.projectCategoryId = projectInfo.categoryId;
    if (projectInfo.categoryId) console.log(`[サクミル] 案件種別: ${projectInfo.categoryName}`);

    const data = await graphql(idToken, `
      mutation PcProjectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) { project { id name } }
      }
    `, { input });

    const project = data.projectCreate.project;
    console.log('[サクミル] 案件登録:', project.id, project.name);

    // ユーザーの最後の案件を記憶（24時間有効）
    if (userId) {
      userLastProject.set(userId, {
        projectId: project.id,
        projectName: project.name,
        expiry: Date.now() + 24 * 60 * 60 * 1000
      });
    }

    return { success: true, projectId: project.id, projectName: project.name };
  } catch (e) {
    console.error('[サクミル] 登録エラー:', e.message);
    return { success: false, message: e.message };
  }
}

// ========== 案件番号でプロジェクトIDを検索 ==========
async function findProjectByNumber(projectNumber) {
  try {
    const idToken = await getFirebaseToken();
    const data = await graphql(idToken, `{
      viewer {
        organization {
          projects(filter: { identifier: { eq: "${projectNumber}" } }) {
            nodes { id name }
          }
        }
      }
    }`);
    const nodes = data?.viewer?.organization?.projects?.nodes || [];
    return nodes[0] || null;
  } catch (e) {
    console.error('[検索] エラー:', e.message);
    return null;
  }
}

// ========== 写真をLINEからダウンロード ==========
async function downloadLineImage(messageId) {
  const res = await httpsDownload('api-data.line.me', `/v2/bot/message/${messageId}/content`, {
    Authorization: `Bearer ${CONFIG.LINE_ACCESS_TOKEN}`,
    'User-Agent': 'Mozilla/5.0'
  });
  return res;
}

// ========== サクミルに写真をアップロード ==========
async function uploadPhotoToSakumiru(projectId, imageBuffer, contentType, filename) {
  if (!CONFIG.SAKUMIRU_ORG_ID) throw new Error('サクミル未初期化');
  const idToken = await getFirebaseToken();

  const data = await graphqlUpload(
    idToken,
    `mutation PcPhotoCreate($input: PhotoCreateInput!) {
      photoCreate(input: $input) { photo { id name } }
    }`,
    { input: { organizationId: CONFIG.SAKUMIRU_ORG_ID, projectId, name: filename, replace: false, file: null } },
    imageBuffer,
    contentType,
    filename
  );

  const photo = data.photoCreate.photo;
  console.log('[サクミル] 写真アップロード:', photo.id, photo.name);
  return photo;
}

// ========== テキストメッセージ処理 ==========
async function handleTextMessage(event) {
  const text = event.message.text;
  const replyToken = event.replyToken;
  const userId = event.source.userId;

  console.log(`[テキスト受信] User: ${userId} | ${text}`);

  const projectInfo = extractProjectInfo(text);

  // 送信者の表示名を取得して顧客を自動判定
  const displayName = await getLineDisplayName(userId);
  console.log(`[送信者] ${displayName || '不明'}`);

  const result = await registerToSakumiru(projectInfo, userId, displayName);

  const lines = ['📋 案件情報を受け取りました', ''];
  if (projectInfo.住所) lines.push(`📍 住所: ${projectInfo.住所}`);
  if (projectInfo.工事内容) lines.push(`🔨 工事: ${projectInfo.工事内容}`);
  if (projectInfo.categoryName) lines.push(`🏷️ 種別: ${projectInfo.categoryName}`);
  if (projectInfo.金額) lines.push(`💴 金額: ${projectInfo.金額}`);
  if (projectInfo.工期開始) lines.push(`📅 工期: ${projectInfo.工期開始}〜${projectInfo.工期終了 || ''}`);
  lines.push('');
  if (result.success) {
    lines.push(`✅ サクミルに登録しました`);
    lines.push(`📝 案件名: ${result.projectName}`);
    lines.push(`📷 続けて写真を送ると自動でこの案件に保存します`);
  } else {
    lines.push(`⚠️ サクミル登録エラー: ${result.message}`);
  }

  await replyToLine(replyToken, lines.filter(Boolean).join('\n'));

  if (result.success) {
    const adminMsg = [
      '🔔 新規案件がサクミルに登録されました', '',
      `📝 案件名: ${result.projectName}`,
      displayName ? `👤 送信者: ${displayName}` : '',
      projectInfo.住所 ? `📍 住所: ${projectInfo.住所}` : '',
      projectInfo.金額 ? `💴 金額: ${projectInfo.金額}` : '',
      projectInfo.工期開始 ? `📅 工期: ${projectInfo.工期開始}〜${projectInfo.工期終了 || ''}` : '',
    ].filter(Boolean).join('\n');
    await pushToAdmin(adminMsg).catch(e => console.error('[Push] 失敗:', e.message));
  }
}

// ========== 画像メッセージ処理 ==========
async function handleImageMessage(event) {
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const messageId = event.message.id;

  console.log(`[画像受信] User: ${userId} | MessageID: ${messageId}`);

  // キャプション（テキスト）から案件番号を確認
  // LINEでは画像単体なのでevent.message.textはない
  // → ユーザーの最後の案件を使用
  let projectId = null;
  let projectName = null;

  const lastProject = userLastProject.get(userId);
  if (lastProject && lastProject.expiry > Date.now()) {
    projectId = lastProject.projectId;
    projectName = lastProject.projectName;
    console.log('[画像] 直前の案件に紐付け:', projectName);
  }

  if (!projectId) {
    await replyToLine(replyToken,
      '⚠️ 写真を紐付ける案件が見つかりません。\n\n先にテキストで案件を登録してから写真を送ってください。\n\nまたは「#案件番号」を含むメッセージと一緒に写真を送ってください。\n例：#20260916-1');
    return;
  }

  try {
    // LINEから画像ダウンロード
    const image = await downloadLineImage(messageId);
    const ext = image.contentType.includes('png') ? 'png' : 'jpg';
    const filename = `LINE_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;

    // サクミルにアップロード
    const photo = await uploadPhotoToSakumiru(projectId, image.buffer, image.contentType, filename);

    await replyToLine(replyToken,
      `📷 写真をサクミルにアップロードしました\n📝 案件: ${projectName}\n🖼️ ファイル名: ${photo.name}`);

    await pushToAdmin(
      `📷 写真が追加されました\n📝 案件: ${projectName}\n🖼️ ${photo.name}`
    ).catch(() => {});

  } catch (e) {
    console.error('[画像アップロード] エラー:', e.message);
    await replyToLine(replyToken, `⚠️ 写真のアップロードに失敗しました: ${e.message}`);
  }
}

// ========== #案件番号 テキスト処理 ==========
async function handleProjectNumberText(event, projectNumber) {
  const replyToken = event.replyToken;
  const userId = event.source.userId;

  console.log(`[案件番号指定] User: ${userId} | #${projectNumber}`);

  const project = await findProjectByNumber(projectNumber);
  if (!project) {
    await replyToLine(replyToken, `⚠️ 案件番号「${projectNumber}」が見つかりません。`);
    return;
  }

  // この案件を「最後の案件」としてセット（24時間有効）
  userLastProject.set(userId, {
    projectId: project.id,
    projectName: project.name,
    expiry: Date.now() + 24 * 60 * 60 * 1000
  });

  await replyToLine(replyToken,
    `✅ 案件「${project.name}」を選択しました。\n続けて写真を送るとこの案件に保存します。`);
}

// ========== Webhookイベント振り分け ==========
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const msg = event.message;

  if (msg.type === 'text') {
    const text = msg.text.trim();
    // #案件番号 だけのメッセージ（写真の案件指定）
    const numMatch = text.match(/^#(\d{8}-\d+|\d+)$/);
    if (numMatch) {
      await handleProjectNumberText(event, numMatch[1]);
    } else {
      await handleTextMessage(event);
    }
  } else if (msg.type === 'image') {
    await handleImageMessage(event);
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
        res.writeHead(403); res.end('Forbidden'); return;
      }
      res.writeHead(200); res.end('OK');
      try {
        const payload = JSON.parse(body);
        for (const event of payload.events || []) await handleEvent(event);
      } catch (e) { console.error('[Webhook] 処理エラー:', e.message); }
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

initSakumiru().then(() => {
  server.listen(CONFIG.PORT, () => {
    console.log(`🚀 LINE → サクミル bot 起動 | Port: ${CONFIG.PORT}`);
  });
});
