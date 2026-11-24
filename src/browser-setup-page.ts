import type { BrowserSetupSession } from './browser-setup.ts'

export type BrowserSetupView = Pick<BrowserSetupSession,
  'stage' | 'error' | 'notice' | 'passwordAvailable' | 'methods' | 'selectedMethod' | 'nodeId' | 'expiresAt'>

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

export function browserSetupPage(view: BrowserSetupView, initial = false) {
  const error = view.error ? `<p role="alert">${escape(view.error)}</p>` : ''
  const target = initial ? '' : '/v1/setup/browser'
  let form = ''
  if (view.stage === 'contact') {
    form = `<form method="post" action="${target}"><label>Muse のメールアドレスまたは電話番号 <input name="contact" autocomplete="username" required maxlength="256"></label><label>地域コード <input name="region" value="JP" maxlength="2" pattern="[A-Za-z]{2}"></label><button type="submit">ログインを開始</button></form>`
  } else if (view.stage === 'otp' || view.stage === 'password') {
    if (view.stage === 'otp') form += `<form method="post" action="${target}"><input type="hidden" name="action" value="otp"><label>確認コード <input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="32"></label><button type="submit">コードを確認</button></form>`
    if (view.passwordAvailable) form += `<form method="post" action="${target}"><input type="hidden" name="action" value="password"><label>Muse のパスワード <input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button type="submit">パスワードで続ける</button></form>`
  } else if (view.stage === 'two_factor') {
    const method = view.methods?.find(item => item.id === view.selectedMethod) ?? view.methods?.[0]
    form = `<p>${method?.type.toUpperCase() === 'SMS' ? 'SMS の確認コードを入力してください。' : 'Muse の二段階認証コードを入力してください。'}</p><form method="post" action="${target}"><input type="hidden" name="action" value="two_factor"><label>確認コード <input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="32"></label><button type="submit">認証してセットアップ</button></form>`
    if (method?.type.toUpperCase() === 'SMS') form += `<form method="post" action="${target}"><input type="hidden" name="action" value="send_code"><button type="submit">SMS を送信・再送</button></form>`
  } else if (view.stage === 'done') {
    form = `<p>セットアップ完了。</p><p>${escape(view.notice ?? 'MuseKnock に戻り、既存のサイドチャットを登録してください。')}</p>`
  } else {
    form = '<p>このリンクでのセットアップを完了できませんでした。MuseKnock で新しいリンクを発行してください。</p>'
  }
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MuseKnock セットアップ</title></head><body><main><h1>MuseKnock セットアップ</h1><p>このページは Meta の公式ログイン画面ではありません。入力した認証情報は、この Worker から Muse の API に送られます。</p><p>接続先 Worker の端末 ID: <code>${escape(view.nodeId)}</code></p><p>有効期限: ${escape(new Date(view.expiresAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }))} JST</p>${error}${form}</main></body></html>`
}

export const browserSetupHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const
