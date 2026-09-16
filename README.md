# LINE → サクミル 自動連携bot

LINEで受け取った案件メッセージを自動でサクミルに登録するbotです。

## 動作フロー

```
LINEメッセージ受信
    ↓
Webhookサーバー（このアプリ）
    ↓
AI（Claude）で案件情報を自動抽出
    ↓
サクミルに自動登録
    ↓
LINEに確認メッセージを返信
```

## セットアップ手順

### 1. Render.comにデプロイ
1. [Render.com](https://render.com)にGitHubアカウントでログイン
2. 「New Web Service」→ このリポジトリを選択
3. 自動でデプロイされる
4. デプロイ後のURL: `https://line-sakumiru-bot.onrender.com`

### 2. LINE Developers ConsoleでWebhook設定
1. [LINE Developers Console](https://developers.line.biz/console/)を開く
2. 「株式会社横浜総建」チャンネルをクリック
3. 「Messaging API設定」タブ
4. Webhook URL: `https://line-sakumiru-bot.onrender.com/webhook`
5. 「Webhookの利用」をONにする
6. 「検証」ボタンで動作確認

### 3. サクミルのログイン情報を設定（後で）
Render.comの環境変数に追加:
- `SAKUMIRU_EMAIL`: サクミルのメールアドレス
- `SAKUMIRU_PASSWORD`: サクミルのパスワード

## 環境変数

| 変数名 | 説明 |
|--------|------|
| `LINE_CHANNEL_SECRET` | LINEチャンネルシークレット |
| `LINE_ACCESS_TOKEN` | LINEアクセストークン |
| `SAKUMIRU_EMAIL` | サクミルのログインID |
| `SAKUMIRU_PASSWORD` | サクミルのパスワード |
| `CLAUDE_API_KEY` | Claude APIキー（オプション・AI抽出精度向上） |
