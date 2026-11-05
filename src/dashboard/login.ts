const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  );

export function loginPage(message = ''): string {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Health MCP">
<meta name="theme-color" content="#07080c">
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="apple-touch-icon" href="/app/icon-180.png">
<title>Health MCP</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 30% 10%, #1b1f3a, #07080c 60%); color: #eef0f6; font: 16px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  form { width: min(340px, calc(100vw - 32px)); display: grid; gap: 14px; text-align: center; }
  h1 { margin: 0; font-size: 34px; letter-spacing: -0.5px; background: linear-gradient(90deg, #7cf3c4, #8ea8ff, #d58bff); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { margin: 0; color: #9aa0b4; }
  input, button { font: inherit; padding: 14px 16px; border-radius: 14px; border: 1px solid #2a2f45; }
  input { background: #10131f; color: #eef0f6; }
  button { background: linear-gradient(90deg, #5be3b0, #7d93ff); color: #07080c; font-weight: 700; border: 0; }
  .err { color: #ff8a8a; min-height: 1.4em; }
</style>
</head>
<body>
<form method="post" action="/app/login">
  <h1>Health MCP</h1>
  <p>Your private health dashboard</p>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
  <button type="submit">Open</button>
  <div class="err">${escapeHtml(message)}</div>
</form>
</body>
</html>`;
}
