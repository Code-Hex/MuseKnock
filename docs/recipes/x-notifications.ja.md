# X でフォローしているアカウントの投稿通知を届ける

[レシピ集](README.ja.md) · [English](x-notifications.md) · [日本語](x-notifications.ja.md) · [简体中文](x-notifications.zh-CN.md)

たとえば、X でフォローしているプロジェクトの告知を Muse でも受け取れます。X アプリのプッシュ通知が届くと、iPhone が Worker に HTTPS リクエストを送ります。X の開発者登録は不要で、X Activity API のイベント料金も発生しません。[X のモバイル通知](https://help.x.com/en/managing-your-account/notifications-on-mobile-devices)・[X Activity API の料金](https://docs.x.com/x-api/activity/event-pricing)

1. iOS 27 の iPhone で X の通知を許可します。フォローしているアカウントのプロフィールを開き、ベルから「すべてのポスト」を選びます。実際の投稿通知がどんな文面で届くか確認します。
2. 「ショートカット」で新規ショートカットを作り、「編集」→「オートメーション」→「通知」で **X** を選びます。そのアカウントの通知だけを拾うには、実際に表示されたアカウント名などを使ってタイトルや本文を絞り込みます。オートメーションを有効にします。[Apple の通知トリガー仕様](https://support.apple.com/en-by/guide/shortcuts/apd932ff833f/10.0/ios/27)
3. 「URLの内容を取得」を追加し、表のホスト名と `YOUR_HOOK_TOKEN` を自分の Worker の値に置き換えます。ショートカットを共有するときはトークンを取り除いてください。

| 設定項目 | 値 |
| --- | --- |
| URL | `https://YOUR-WORKER/hooks/custom` |
| 方法 | `POST` |
| ヘッダー | `Authorization` = `Bearer YOUR_HOOK_TOKEN` |
| 要求本文 | **JSON** · `message` = `指定した条件の X 通知が届きました。` |

見出しも送りたい場合は、JSON の `message` に変数「通知」の「タイトル」を指定します。プレビューがある通知は本文も選べます。操作なしで届けるには、トリガーの実行前の確認をオフにし、ロック中の実行を許可します。次に条件に合う通知が届いたら、選択中の Muse サイドチャットを確認してください。[Apple の自動実行設定](https://support.apple.com/guide/shortcuts/add-automations-apdfbdbd7123/ios)・[iOS 27 実機での通知変数の検証例](https://notikeep.app/en/ios-27-notification-automation/)

この方法で拾えるのは、設定後に iPhone に届いた通知です。取り逃した投稿の復元や削除イベントの検知はできません。公開投稿の ID、URL、削除イベントが必要な用途には [X API を使う直接連携](../../README.ja.md#x-の公開投稿)が適しています。
