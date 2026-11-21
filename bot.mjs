// iBox Discord bot: iNetbox status, new iBox releases and iNetbox catalog updates.
// Runs once per call (GitHub Actions every 5 minutes). State lives in the Discord messages themselves.

const API = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNELS = {
  status: process.env.STATUS_CHANNEL,
  releases: process.env.RELEASES_CHANNEL,
  catalog: process.env.CATALOG_CHANNEL,
};
const INETBOX = process.env.INETBOX_URL || 'https://inetbox-server.onrender.com';
const REPO = process.env.IBOX_REPO || 'atzski/ibox';
const SITE = 'https://atzski.github.io/ibox/en.html';
const STATUS_MARKER = 'iNetbox status';
const ONLINE = 'iNetbox is online';
const COLOR = { up: 0x22c55e, down: 0xef4444, ibox: 0xe5534b, catalog: 0x8b5cf6 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

if (!TOKEN) throw new Error('DISCORD_BOT_TOKEN is missing');

async function discord(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'User-Agent': 'DiscordBot (https://github.com/atzski/ibox-bot, 1.0)',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep((j.retry_after || 1) * 1000 + 250);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`Rate limited: ${method} ${path}`);
}

async function github(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ibox-bot' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch('https://api.github.com' + path, { headers });
  if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- iNetbox status

async function probe() {
  let error = 'unknown error';
  const tries = Number(process.env.HEALTH_TRIES) || 3;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${INETBOX}/health`, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'ibox-bot' } });
      if (res.ok) {
        const j = await res.json();
        return { up: true, version: j.version, ms: Date.now() - t0 };
      }
      error = `HTTP ${res.status}`;
    } catch (e) {
      error = e.name === 'TimeoutError' ? 'no response after 60 seconds' : e.message;
    }
    console.log(`health attempt ${attempt} failed: ${error}`);
    if (attempt < tries) await sleep(20_000);
  }
  return { up: false, error };
}

function minutes(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}

function statusEmbed(state, since) {
  const checked = `Last check: <t:${now()}:R>`;
  if (state.up) {
    return {
      author: { name: STATUS_MARKER },
      color: COLOR.up,
      description: `# 🟢 ${ONLINE}\nAll online features of iBox are available.\n${checked}`,
      fields: [
        { name: 'Server version', value: state.version || 'unknown', inline: true },
        { name: 'Response time', value: `${state.ms} ms`, inline: true },
        { name: 'Online since', value: `<t:${since}:f>`, inline: true },
      ],
      footer: { text: 'Checked every 5 minutes' },
      timestamp: new Date(since * 1000).toISOString(),
    };
  }
  return {
    author: { name: STATUS_MARKER },
    color: COLOR.down,
    description:
      `# 🔴 iNetbox is offline\n` +
      'The server is not responding. Accounts, friends, chat, shares and the catalog are unavailable for now. ' +
      `Your local library still works.\n${checked}`,
    fields: [
      { name: 'Reason', value: state.error, inline: true },
      { name: 'Offline since', value: `<t:${since}:f>`, inline: true },
    ],
    footer: { text: 'Checked every 5 minutes' },
    timestamp: new Date(since * 1000).toISOString(),
  };
}

async function updateStatus(me) {
  const ch = CHANNELS.status;
  const state = await probe();
  console.log('iNetbox', state.up ? `up ${state.version} ${state.ms} ms` : `down: ${state.error}`);

  const pins = await discord('GET', `/channels/${ch}/pins`);
  const isStatus = (e) => e && (e.author?.name === STATUS_MARKER || e.title?.startsWith('iNetbox is'));
  const pinned = pins.find((m) => m.author.id === me.id && isStatus(m.embeds?.[0]));
  const prev = pinned?.embeds[0];
  const prevUp = prev ? `${prev.title || ''} ${prev.description || ''}`.includes(ONLINE) : null;
  const prevSince = prev?.timestamp ? Math.floor(Date.parse(prev.timestamp) / 1000) : now();
  const changed = prevUp !== null && prevUp !== state.up;
  const since = prevUp === state.up ? prevSince : now();
  const embed = statusEmbed(state, since);

  if (pinned) {
    await discord('PATCH', `/channels/${ch}/messages/${pinned.id}`, { embeds: [embed] });
  } else {
    const msg = await discord('POST', `/channels/${ch}/messages`, { embeds: [embed] });
    await discord('PUT', `/channels/${ch}/pins/${msg.id}`);
    // Remove the "pinned a message" system notice.
    const recent = await discord('GET', `/channels/${ch}/messages?limit=5`);
    for (const m of recent) if (m.type === 6) await discord('DELETE', `/channels/${ch}/messages/${m.id}`);
  }

  if (changed) {
    const content = state.up
      ? `**iNetbox is back online** after ${minutes(now() - prevSince)} of downtime.`
      : `**iNetbox is offline** since <t:${since}:t>. This channel will say when it is back.`;
    await discord('POST', `/channels/${ch}/messages`, { content });
  }
  return state;
}

// ---------------------------------------------------------------- iBox releases

function releaseNotes(body) {
  const sections = (body || '').split(/^## /m);
  const news = sections.find((s) => /^What's new/i.test(s)) || sections.find((s) => /^Nouveautés/i.test(s));
  const text = (news ? news.replace(/^[^\n]*\n/, '') : body || '').trim();
  return text.length > 3500 ? text.slice(0, 3500).replace(/\s+\S*$/, '') + ' ...' : text;
}

async function postReleases(me) {
  const ch = CHANNELS.releases;
  const releases = (await github(`/repos/${REPO}/releases?per_page=10`))
    .filter((r) => !r.draft)
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
  const msgs = await discord('GET', `/channels/${ch}/messages?limit=50`);
  const posted = new Set(msgs.filter((m) => m.author.id === me.id).flatMap((m) => m.embeds.map((e) => e.url)));
  const lastIndex = releases.findLastIndex((r) => posted.has(r.html_url));
  const todo = lastIndex === -1 ? releases.slice(-1) : releases.slice(lastIndex + 1);

  for (const r of todo) {
    const version = r.tag_name.replace(/^v/, '');
    const asset = (re) => r.assets.find((a) => re.test(a.name) && !a.name.endsWith('.sig'));
    const exe = asset(/setup\.exe$/);
    const appimage = asset(/\.AppImage$/);
    const links = [
      exe && `[Windows installer](${exe.browser_download_url})`,
      appimage && `[Steam Deck / Linux](${appimage.browser_download_url})`,
      `[Website](${SITE})`,
    ].filter(Boolean);
    const embed = {
      title: `iBox ${version} is out${r.prerelease ? ' (pre-release)' : ''}`,
      url: r.html_url,
      color: COLOR.ibox,
      description: releaseNotes(r.body),
      fields: [{ name: 'Download', value: links.join(' · ') }],
      footer: { text: 'Already installed? iBox offers the update automatically.' },
      timestamp: r.published_at,
    };
    const msg = await discord('POST', `/channels/${ch}/messages`, { embeds: [embed] });
    await discord('POST', `/channels/${ch}/messages/${msg.id}/crosspost`).catch((e) => console.log('crosspost:', e.message));
    console.log('release posted', version);
  }
}

// ---------------------------------------------------------------- iNetbox catalog

async function postCatalog(me) {
  const ch = CHANNELS.catalog;
  const res = await fetch(`${INETBOX}/v1/plugins`, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'ibox-bot' } });
  if (!res.ok) throw new Error(`catalog -> HTTP ${res.status}`);
  const { plugins = [] } = await res.json();
  const msgs = await discord('GET', `/channels/${ch}/messages?limit=100`);
  const keys = msgs.filter((m) => m.author.id === me.id).map((m) => m.embeds?.[0]?.footer?.text || '');

  for (const p of plugins) {
    const key = `Catalog id: ${p.id} · version ${p.version}`;
    if (keys.includes(key)) continue;
    const isUpdate = keys.some((k) => k.startsWith(`Catalog id: ${p.id} ·`));
    const fields = [{ name: 'Author', value: p.author?.name || 'unknown', inline: true }];
    if (p.size) fields.push({ name: 'Size', value: `${(p.size / 1048576).toFixed(1)} MB`, inline: true });
    await discord('POST', `/channels/${ch}/messages`, {
      embeds: [{
        title: `${isUpdate ? 'Updated' : 'New in the catalog'}: ${p.name} ${p.version}`,
        color: COLOR.catalog,
        description: `${p.description || ''}\n\nInstall it from the iNetbox catalog inside iBox.`.trim(),
        fields,
        footer: { text: key },
      }],
    });
    keys.push(key);
    console.log('catalog posted', p.id, p.version);
  }
}

// ---------------------------------------------------------------- main

const me = await discord('GET', '/users/@me');
let failed = false;
const step = async (name, fn) => {
  try { return await fn(); } catch (e) { failed = true; console.error(`${name} failed:`, e.message); }
};

const state = await step('status', () => updateStatus(me));
await step('releases', () => postReleases(me));
if (state?.up) await step('catalog', () => postCatalog(me));
if (failed) process.exit(1);
