const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.6}
nav a{margin-right:16px}
</style>
</head>
<body>
<nav><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
<h1>${title}</h1>
${body}
</body>
</html>`;

export const homePage = page(
  'Google Health MCP',
  `<p>This is a private, single-user connector. It lets its owner's Claude assistant read
the owner's own Google Health data (sleep, heart rate, activity and workouts) and write
food, activity, weight and sleep logs.</p>
<p>It is not a public service and does not accept other users.</p>`,
);

export const privacyPage = page(
  'Privacy policy',
  `<p>Last updated 10 October 2026.</p>
<h2>What is accessed</h2>
<p>With the owner's consent, this connector reads and writes the owner's Google Health data
through the Google Health API, with the scopes the owner granted during setup.</p>
<h2>How it is used</h2>
<p>Data is used only to answer the owner's own requests in their assistant. It is never
sold, shared with other people or used for advertising.</p>
<h2>Storage</h2>
<p>Sign-in tokens are stored in the owner's Cloudflare account. Health API
responses are cached there for up to one hour.</p>
<h2>Google API data</h2>
<p>Use of information received from Google APIs follows the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services
User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Revoking access</h2>
<p>Access can be removed at any time at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>`,
);

export const termsPage = page(
  'Terms of use',
  `<p>Last updated 10 October 2026.</p>
<p>This connector is a personal tool for its owner only. It is provided as is, with no warranty.
It offers general wellness information, not medical advice or diagnosis.</p>`,
);
