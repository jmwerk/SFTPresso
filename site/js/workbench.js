/* =====================================================================
   SFTPresso landing page — workbench behaviour.
   Plain ES2020, no dependencies. Everything here is a demo of the UI:
   nothing connects anywhere.
   ===================================================================== */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const workbench = $('#workbench');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const MOD = isMac ? '⌘' : 'Ctrl';

  // ------------------------------------------------------------------ files
  const FILES = {
    'README.md': { label: 'README.md', path: ['README.md'], icon: 'fi-readme', lang: 'Markdown', title: 'SFTPresso — SFTP/FTP sync for Visual Studio Code' },
    'features.md': { label: 'features.md', path: ['docs', 'features.md'], icon: 'fi-md', lang: 'Markdown', title: 'Features' },
    'quick-start.md': { label: 'quick-start.md', path: ['docs', 'quick-start.md'], icon: 'fi-md', lang: 'Markdown', title: 'Quick start' },
    'commands.md': { label: 'commands.md', path: ['docs', 'commands.md'], icon: 'fi-md', lang: 'Markdown', title: 'Command reference' },
    'workflows.md': { label: 'workflows.md', path: ['docs', 'workflows.md'], icon: 'fi-md', lang: 'Markdown', title: 'Workflows' },
    'security.md': { label: 'security.md', path: ['docs', 'security.md'], icon: 'fi-md', lang: 'Markdown', title: 'Security' },
    'CHANGELOG.md': { label: 'CHANGELOG.md', path: ['CHANGELOG.md'], icon: 'fi-md', lang: 'Markdown', title: 'Changelog' },
    'LICENSE': { label: 'LICENSE', path: ['LICENSE'], icon: 'fi-license', lang: 'Plain Text', title: 'License' },
    'sftp.json': { label: 'sftp.json', path: ['.vscode', 'sftp.json'], icon: 'fi-json', lang: 'JSON with Comments', title: 'sftp.json configuration' },
    'extension': { label: 'Extension: SFTPresso', path: ['Extension: SFTPresso'], icon: 'fi-ext', lang: 'Extension', title: 'Install SFTPresso' },
    'remote:index.html': { label: 'index.html', path: ['acme.example.com', 'var', 'www', 'acme', 'index.html'], icon: 'fi-html', lang: 'HTML', title: 'index.html (remote)', readonly: true },
    'remote:style.css': { label: 'style.css', path: ['acme.example.com', 'var', 'www', 'acme', 'css', 'style.css'], icon: 'fi-css', lang: 'CSS', title: 'style.css (remote)', readonly: true },
  };

  // Hover documentation for sftp.json keys (abridged from the wiki).
  const OPTION_DOCS = {
    name: ['string', 'A label for this configuration. Shown in pickers when several configs exist; required in an array (multi-context) config.'],
    protocol: ['"sftp" | "ftp"', 'Transfer protocol. Default <code>"sftp"</code>. FTPS is <code>"ftp"</code> plus <code>secure</code>.'],
    host: ['string', 'Hostname or IP address of the server. An alias from <code>~/.ssh/config</code> works too: <code>HostName</code>, <code>Port</code>, <code>User</code>, and <code>IdentityFile</code> are read from it.'],
    port: ['integer', 'Server port. Typically 22 for SFTP, 21 for FTP, 990 for implicit FTPS.'],
    username: ['string', 'Username for authentication.'],
    privateKeyPath: ['string', 'Absolute path to your private key. Set <code>"passphrase": true</code> to be prompted for an encrypted key, or use <code>agent</code> for ssh-agent / Pageant.'],
    remotePath: ['string', 'Absolute path on the remote host that maps to your local folder (or <code>context</code>). What <em>Download Project</em> fetches. Default <code>"/"</code>.'],
    uploadOnSave: ['boolean', 'Upload the file on every VS Code save. Flip it without editing JSON via <strong>SFTP: Toggle Upload on Save</strong>. Default <code>false</code>.'],
    conflictCheck: ['boolean', 'Before an upload replaces a remote file, check whether the remote changed since you last transferred it. If it did, choose Overwrite, Open Diff, or Cancel. Default <code>false</code>.'],
    useTempFile: ['boolean', 'Upload to a temporary file first, then move it into place, so visitors never see a half-written file. Default <code>false</code>.'],
    openSsh: ['boolean', 'Atomic rename-into-place uploads. OpenSSH servers only; requires <code>useTempFile</code>. Default <code>false</code>.'],
    ignore: ['string[]', 'Gitignore-style patterns excluded from transfers and sync, relative to <code>context</code>. Bypass with the Force (Alt) commands.'],
    maxFileSize: ['number', 'Cap in MB for files in a <em>batch</em> transfer (folder upload/download, sync). Larger files are skipped and summarised. <code>0</code> disables.'],
    watcher: ['object', 'React to changes made outside VS Code — build output, <code>git checkout</code>, other tools. <code>files</code> is a glob; <code>autoUpload</code>, <code>autoDelete</code>, <code>autoRename</code> choose what happens.'],
    files: ['glob', 'Which files the watcher observes. Required inside <code>watcher</code>. A profile can set <code>"files": false</code> to turn the watcher off.'],
    autoUpload: ['boolean', 'Upload when a watched file changes.'],
    autoDelete: ['boolean', 'Delete on the remote when a watched file is removed locally.'],
    autoRename: ['boolean', 'Turn a rename or move made in VS Code\'s Explorer into a single server-side <code>rename()</code> instead of delete-and-re-upload. Default <code>false</code>.'],
    syncOption: ['object', 'Tunes the Sync commands: <code>delete</code> extraneous files, <code>skipCreate</code>, <code>ignoreExisting</code>, and <code>update</code> (only overwrite when the source is newer). All off by default.'],
    syncConfirm: ['boolean', 'Show a dry-run preview — uploads, overwrites, deletions — and ask before a sync runs. Defaults to <code>true</code> whenever <code>syncOption.delete</code> is enabled.'],
    strictHostKeyChecking: ['true | false | "ask" | "accept-new"', 'How SSH host keys are checked, mirroring OpenSSH. Default <code>"accept-new"</code>: unknown hosts are remembered silently, a changed key is refused.'],
    transferMode: ['"auto" | "parallel" | "stream"', 'How a file\'s bytes move on SFTP. <code>"auto"</code> chunks files over ~256 KB into concurrent requests so latency stops bounding throughput. Default <code>"auto"</code>.'],
    concurrency: ['number', 'Maximum simultaneous transfers and directory listings on one connection. Lower it for shared hosts that rate-limit. FTP always uses 1. Default <code>4</code>.'],
    retry: ['object', 'Automatically re-run a transfer that failed for a transient reason (dropped connection, timeout, FTP 4xx) with doubling backoff. Default <code>{ "attempts": 2, "delay": 1000 }</code>.'],
    attempts: ['number', 'Extra attempts a failed transfer gets. <code>0</code> disables retry.'],
    delay: ['number', 'Base backoff in ms, doubled on every attempt and capped at 15 s.'],
    operationTimeout: ['number', 'Deadline in ms for any single remote request (<code>mkdir</code>, <code>stat</code>, listing, rename). An unanswered request fails with ETIMEDOUT and the connection is dropped so the next command starts fresh. Default <code>60000</code>. SFTP only.'],
    idleTimeout: ['number', 'After this many ms unused, a pooled connection gets a cheap health check before reuse and is replaced if it doesn\'t answer. Set a bit under your host\'s idle limit. Default <code>0</code> (never).'],
    stallTimeout: ['number', 'Fail a transfer that goes this many ms without a single byte moving, so a connection that dies mid-transfer doesn\'t hang forever. Retried automatically. Default <code>0</code> (wait indefinitely).'],
    keepaliveInterval: ['number', 'How often an SSH keepalive packet is sent, in ms. Falls back to <code>ServerAliveInterval</code> from your ssh config. Default <code>30000</code>.'],
    remoteCommands: ['object', 'Labelled shell commands offered by <strong>SFTP: Run Remote Command</strong> as a quick pick. Run over the existing SSH connection, no re-authentication. SFTP only.'],
    remoteExplorer: ['object', '<code>filesExclude</code> hides patterns in the Remote Explorer, <code>order</code> sorts roots, and <code>enableDragAndDrop</code> allows drag-to-move and dropping files in from your OS.'],
    filesExclude: ['string[]', 'Patterns for files and folders to hide in the Remote Explorer.'],
    enableDragAndDrop: ['boolean', 'Allow dragging an item onto a folder to move it with a single server-side rename, and dragging files in from your file manager to upload them. Default <code>false</code>.'],
    profiles: ['object', 'Named profiles merged over the top-level config. Switch with <strong>SFTP: Set Profile</strong> or by clicking the profile in the status bar; deploy to every one with the <em>… To All Profiles</em> commands.'],
    defaultProfile: ['string', 'The profile activated by default.'],
    staging: ['profile', 'A profile. Anything set here overrides the top-level value while the profile is active.'],
    prod: ['profile', 'A profile. Anything set here overrides the top-level value while the profile is active.'],
    'Restart PHP': ['command', 'A saved remote command label. Pick it from <strong>SFTP: Run Remote Command</strong>.'],
    'Clear cache': ['command', 'A saved remote command label. Pick it from <strong>SFTP: Run Remote Command</strong>.'],
    update: ['boolean', 'Only overwrite the destination if the source copy is newer.'],
    delete: ['boolean', 'Delete extraneous files from the destination during a sync.'],
  };

  // ------------------------------------------------------------------ state
  const state = {
    tabs: [],
    active: null,
    view: 'explorer',
    profile: 'staging',
    uploadOnSave: true,
    connection: 'idle',
    transfers: [],
    transferTimer: null,
    filter: '',
    panelTab: 'terminal',
    terminals: {},
  };

  // ------------------------------------------------------------------ theme
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f8f8f8' : '#181818');
    $$('[data-action="toggle-theme"] use').forEach((u) => u.setAttribute('href', theme === 'light' ? '#i-sun' : '#i-moon'));
    try { localStorage.setItem('sftpresso.theme', theme); } catch (e) { /* ignore */ }
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    logOutput('info', `color theme switched to ${next === 'light' ? 'Light Modern' : 'Dark Modern'}`);
  }
  (function initTheme() {
    let theme = null;
    try { theme = localStorage.getItem('sftpresso.theme'); } catch (e) { /* ignore */ }
    // VS Code itself defaults to Dark Modern; a stored choice wins.
    if (!theme) theme = 'dark';
    applyTheme(theme);
  })();

  // ------------------------------------------------------------------ output channel
  const outputLog = $('#output-log');
  function timestamp() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  }
  function logOutput(level, msg) {
    const line = document.createElement('div');
    line.innerHTML = `<span class="ts">[${timestamp()}]</span> <span class="lvl-${level}">[${level}]</span> ${escapeHtml(msg)}`;
    outputLog.appendChild(line);
    outputLog.parentElement.scrollTop = outputLog.parentElement.scrollHeight;
  }

  // ------------------------------------------------------------------ notifications
  const notifications = $('#notifications');
  function notify(message, opts = {}) {
    const { type = 'info', source = 'SFTPresso', actions = [], timeout = 6000, progress = false } = opts;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const iconId = type === 'error' ? '#i-error' : type === 'warning' ? '#i-warning' : '#i-info';
    toast.innerHTML = `
      <div class="toast-main">
        <svg class="icon"><use href="${iconId}"/></svg>
        <div class="toast-msg">${message}<span class="toast-source">Source: ${escapeHtml(source)}</span></div>
        <button class="icon-btn toast-close" aria-label="Clear notification"><svg class="icon"><use href="#i-close"/></svg></button>
      </div>`;
    if (actions.length) {
      const bar = document.createElement('div');
      bar.className = 'toast-actions';
      actions.forEach((a, i) => {
        const b = document.createElement('button');
        b.className = 'btn' + (i === 0 ? ' btn-primary' : '');
        b.textContent = a.label;
        b.addEventListener('click', () => { dismiss(); a.run && a.run(); });
        bar.appendChild(b);
      });
      toast.appendChild(bar);
    }
    let bar = null;
    if (progress) { bar = document.createElement('div'); bar.className = 'toast-progress'; toast.appendChild(bar); }
    notifications.appendChild(toast);
    let timer = timeout ? setTimeout(dismiss, timeout) : null;
    function dismiss() {
      if (timer) clearTimeout(timer);
      if (!toast.isConnected) return;
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 160);
    }
    $('.toast-close', toast).addEventListener('click', dismiss);
    return {
      dismiss,
      setMessage(html) { $('.toast-msg', toast).firstChild.nodeValue = ''; $('.toast-msg', toast).innerHTML = html + `<span class="toast-source">Source: ${escapeHtml(source)}</span>`; },
      setProgress(p) { if (bar) bar.style.width = `${Math.round(p * 100)}%`; },
    };
  }

  // ------------------------------------------------------------------ syntax highlighting
  // Every highlighter returns an array of lines, each a list of
  // { cls, text, doc? } tokens. Tokens are rendered with DOM APIs (never
  // innerHTML), so the source text is only ever treated as text.
  function highlightJsonc(source, withDocs) {
    const lines = source.split('\n');
    let depth = 0;
    let inBlock = false;
    const out = [];
    for (const line of lines) {
      const toks = [];
      let i = 0;
      while (i < line.length) {
        const rest = line.slice(i);
        let m;
        if (inBlock) {
          const end = rest.indexOf('*/');
          if (end === -1) { toks.push({ cls: 'tok-comment', text: rest }); i = line.length; }
          else { toks.push({ cls: 'tok-comment', text: rest.slice(0, end + 2) }); i += end + 2; inBlock = false; }
          continue;
        }
        if (rest.startsWith('//')) { toks.push({ cls: 'tok-comment', text: rest }); break; }
        if (rest.startsWith('/*')) { inBlock = true; continue; }
        if ((m = /^"(?:[^"\\]|\\.)*"/.exec(rest))) {
          const isKey = /^\s*:/.test(rest.slice(m[0].length));
          const raw = m[0].slice(1, -1);
          if (isKey) {
            const doc = withDocs && OPTION_DOCS[raw];
            toks.push(doc ? { cls: 'tok-key has-doc', text: m[0], doc: raw } : { cls: 'tok-key', text: m[0] });
          } else {
            toks.push({ cls: 'tok-str', text: m[0] });
          }
          i += m[0].length; continue;
        }
        if ((m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest))) { toks.push({ cls: 'tok-num', text: m[0] }); i += m[0].length; continue; }
        if ((m = /^(?:true|false|null)\b/.exec(rest))) { toks.push({ cls: 'tok-kw', text: m[0] }); i += m[0].length; continue; }
        const ch = rest[0];
        if (ch === '{' || ch === '[') { toks.push({ cls: `tok-b${depth % 3}`, text: ch }); depth++; i++; continue; }
        if (ch === '}' || ch === ']') { depth = Math.max(0, depth - 1); toks.push({ cls: `tok-b${depth % 3}`, text: ch }); i++; continue; }
        if (ch === ':' || ch === ',') { toks.push({ cls: 'tok-punct', text: ch }); i++; continue; }
        toks.push({ cls: '', text: ch }); i++;
      }
      out.push(toks);
    }
    return out;
  }
  function highlightHtml(source) {
    return source.split('\n').map((line) => {
      const toks = [];
      let i = 0;
      while (i < line.length) {
        const rest = line.slice(i);
        let m;
        if ((m = /^<!DOCTYPE[^>]*>/i.exec(rest))) { toks.push({ cls: 'tok-comment', text: m[0] }); i += m[0].length; continue; }
        if ((m = /^(<\/?)([a-zA-Z][\w-]*)/.exec(rest))) {
          toks.push({ cls: 'tok-punct', text: m[1] });
          toks.push({ cls: 'tok-tag', text: m[2] });
          i += m[0].length;
          while (i < line.length) {
            const r = line.slice(i);
            let a;
            if ((a = /^\/?>/.exec(r))) { toks.push({ cls: 'tok-punct', text: a[0] }); i += a[0].length; break; }
            if ((a = /^\s+/.exec(r))) { toks.push({ cls: '', text: a[0] }); i += a[0].length; continue; }
            if ((a = /^([\w-]+)(=)("[^"]*"|'[^']*')/.exec(r))) {
              toks.push({ cls: 'tok-attr', text: a[1] }, { cls: 'tok-punct', text: a[2] }, { cls: 'tok-str', text: a[3] });
              i += a[0].length; continue;
            }
            if ((a = /^[\w-]+/.exec(r))) { toks.push({ cls: 'tok-attr', text: a[0] }); i += a[0].length; continue; }
            toks.push({ cls: '', text: r[0] }); i++;
          }
          continue;
        }
        const next = rest.indexOf('<', 1);
        const text = next === -1 ? rest : rest.slice(0, next);
        toks.push({ cls: '', text });
        i += text.length;
      }
      return toks;
    });
  }
  function highlightCss(source) {
    return source.split('\n').map((line) => {
      let m;
      if ((m = /^(.*?)(\{\s*)$/.exec(line))) return [{ cls: 'tok-sel', text: m[1] }, { cls: 'tok-b0', text: m[2] }];
      if (/^\s*\}/.test(line)) return [{ cls: 'tok-b0', text: line }];
      if ((m = /^(\s*)([\w-]+)(\s*:\s*)(.*?)(;?)$/.exec(line))) {
        return [{ cls: '', text: m[1] }, { cls: 'tok-prop', text: m[2] }, { cls: '', text: m[3] }, { cls: 'tok-str', text: m[4] }, { cls: '', text: m[5] }];
      }
      return [{ cls: '', text: line }];
    });
  }
  function highlightShell(source) {
    return source.split('\n').map((line) => {
      const toks = [];
      let rest = line;
      const m = /^\$\s/.exec(rest);
      if (m) { toks.push({ cls: 'term-dim', text: m[0] }); rest = rest.slice(m[0].length); }
      const h = rest.indexOf('#');
      if (h === -1) toks.push({ cls: '', text: rest });
      else toks.push({ cls: '', text: rest.slice(0, h) }, { cls: 'tok-comment', text: rest.slice(h) });
      return toks;
    });
  }
  function highlightPlain(source) {
    return source.split('\n').map((line) => [{ cls: '', text: line }]);
  }
  function appendTokens(target, toks) {
    toks.forEach((tok) => {
      if (!tok.text) return;
      if (!tok.cls) { target.appendChild(document.createTextNode(tok.text)); return; }
      const span = document.createElement('span');
      span.className = tok.cls;
      span.textContent = tok.text;
      if (tok.doc) span.dataset.doc = tok.doc;
      target.appendChild(span);
    });
  }
  function renderCodeEditor(container) {
    const pre = $('.code-source', container);
    if (!pre) return;
    const lang = container.dataset.lang;
    let source = (pre.dataset.source || pre.textContent).replace(/\n$/, '');
    if (container.closest('[data-file="sftp.json"]')) {
      source = source.replace(/"uploadOnSave": (true|false)/, `"uploadOnSave": ${state.uploadOnSave}`);
      source = source.replace(/"defaultProfile": "[^"]*"/, `"defaultProfile": "${state.profile}"`);
    }
    const lines = lang === 'jsonc' ? highlightJsonc(source, true) : lang === 'html' ? highlightHtml(source) : lang === 'css' ? highlightCss(source) : highlightPlain(source);
    pre.textContent = '';
    lines.forEach((toks, i) => {
      const row = document.createElement('div');
      row.className = i === 0 ? 'code-line active' : 'code-line';
      const num = document.createElement('span');
      num.className = 'line-number';
      num.textContent = String(i + 1);
      const content = document.createElement('span');
      content.className = 'line-content';
      if (toks.length) appendTokens(content, toks); else content.textContent = ' ';
      row.append(num, content);
      pre.appendChild(row);
    });
    pre.dataset.source = source;
  }
  function renderCodeBlocks(root) {
    $$('pre.code', root).forEach((pre) => {
      const code = $('code', pre) || pre;
      const src = code.textContent;
      const lang = pre.dataset.lang;
      const lines = lang === 'jsonc' ? highlightJsonc(src, false) : lang === 'sh' ? highlightShell(src) : null;
      if (!lines) return;
      code.textContent = '';
      lines.forEach((toks, i) => {
        if (i) code.appendChild(document.createTextNode('\n'));
        appendTokens(code, toks);
      });
    });
  }

  // ------------------------------------------------------------------ editors / tabs
  const tabsEl = $('#tabs');
  const editorContainer = $('#editor-container');
  const breadcrumbsEl = $('#breadcrumbs');
  const editorInstances = {};

  function renderTabs() {
    tabsEl.innerHTML = '';
    state.tabs.forEach((id) => {
      const f = FILES[id];
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === state.active ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', id === state.active);
      tab.dataset.tab = id;
      tab.title = f.path.join('/');
      const iconHtml = f.icon === 'fi-ext' ? '<img src="assets/icon.png" alt="" width="16" height="16">' : `<span class="file-icon ${f.icon}"></span>`;
      tab.innerHTML = `${iconHtml}<span class="tab-label">${f.readonly ? `<em>${f.label}</em>` : f.label}</span><button class="tab-close" aria-label="Close ${f.label}"><svg class="icon"><use href="#i-close"/></svg></button>`;
      tab.addEventListener('click', (e) => { if (!e.target.closest('.tab-close')) activateFile(id); });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeFile(id); } });
      $('.tab-close', tab).addEventListener('click', (e) => { e.stopPropagation(); closeFile(id); });
      tabsEl.appendChild(tab);
    });
    const activeTab = $('.tab.active', tabsEl);
    if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function renderBreadcrumbs() {
    if (!state.active) { breadcrumbsEl.innerHTML = ''; return; }
    const f = FILES[state.active];
    breadcrumbsEl.innerHTML = f.path.map((seg, i) => {
      const last = i === f.path.length - 1;
      const icon = last && f.icon !== 'fi-ext' ? `<span class="file-icon ${f.icon}"></span>` : '';
      return `<span class="crumb">${icon}${escapeHtml(seg)}</span>`;
    }).join('');
  }
  function ensureEditor(id) {
    if (editorInstances[id]) return editorInstances[id];
    const tpl = document.getElementById(`editor-${id}`);
    const el = document.createElement('div');
    el.className = 'editor-instance';
    el.dataset.file = id;
    el.hidden = true;
    if (tpl) el.appendChild(tpl.content.cloneNode(true));
    $$('.code-editor', el).forEach(renderCodeEditor);
    renderCodeBlocks(el);
    $$('.doc table', el).forEach((table) => { const wrap = document.createElement('div'); wrap.className = 'table-wrap'; table.replaceWith(wrap); wrap.appendChild(table); });
    editorContainer.appendChild(el);
    editorInstances[id] = el;
    return el;
  }
  function openFile(id, opts = {}) {
    if (!FILES[id]) return;
    if (!state.tabs.includes(id)) {
      const idx = state.tabs.indexOf(state.active);
      state.tabs.splice(idx === -1 ? state.tabs.length : idx + 1, 0, id);
    }
    activateFile(id, opts);
  }
  function activateFile(id, opts = {}) {
    state.active = id;
    Object.keys(editorInstances).forEach((k) => { editorInstances[k].hidden = true; });
    const el = ensureEditor(id);
    el.hidden = false;
    editorContainer.scrollTop = 0;
    renderTabs();
    renderBreadcrumbs();
    renderEmptyState();
    $('#status-language').textContent = FILES[id].lang;
    $('#status-cursor').textContent = 'Ln 1, Col 1';
    document.title = `${FILES[id].title} — SFTPresso`;
    $$('#file-tree .tree-item').forEach((li) => li.classList.toggle('selected', li.dataset.file === id));
    if (!opts.silent) {
      const hash = id === 'README.md' ? '' : `#${id}`;
      if (location.hash !== hash) history.pushState({ file: id }, '', hash || location.pathname + location.search);
    }
    if (opts.anchor) {
      const target = el.querySelector(`#${CSS.escape(opts.anchor)}`);
      if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 30);
    }
    updateOutline(el);
  }
  function closeFile(id) {
    const idx = state.tabs.indexOf(id);
    if (idx === -1) return;
    state.tabs.splice(idx, 1);
    if (editorInstances[id]) { editorInstances[id].remove(); delete editorInstances[id]; }
    if (state.active === id) {
      const next = state.tabs[idx] || state.tabs[idx - 1] || null;
      if (next) activateFile(next);
      else { state.active = null; renderTabs(); renderBreadcrumbs(); renderEmptyState(); document.title = 'SFTPresso — SFTP/FTP sync for Visual Studio Code'; updateOutline(null); }
    } else renderTabs();
  }
  function renderEmptyState() {
    let empty = $('.editor-empty', editorContainer);
    if (state.active) { if (empty) empty.remove(); return; }
    if (empty) return;
    empty = document.createElement('div');
    empty.className = 'editor-empty';
    empty.innerHTML = `<img src="assets/icon.png" alt="">
      <table>
        <tr><td>Show All Commands</td><td><kbd>${MOD}</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd></td></tr>
        <tr><td>Go to File</td><td><kbd>${MOD}</kbd> + <kbd>P</kbd></td></tr>
        <tr><td>Toggle Terminal</td><td><kbd>${MOD}</kbd> + <kbd>\`</kbd></td></tr>
        <tr><td>Open README</td><td><button class="link-btn" data-file="README.md">README.md</button></td></tr>
      </table>`;
    editorContainer.appendChild(empty);
  }
  function updateOutline(el) {
    const outline = $('#outline-tree');
    outline.innerHTML = '';
    if (!el) return;
    $$('h1, h2', el).forEach((h) => {
      const li = document.createElement('li');
      li.className = 'tree-item file';
      const depth = h.tagName === 'H1' ? 0 : 1;
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.setProperty('--depth', String(depth));
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = h.textContent.trim();
      row.appendChild(label);
      li.appendChild(row);
      li.addEventListener('click', () => { h.scrollIntoView({ block: 'start' }); });
      outline.appendChild(li);
    });
  }

  // Cursor position for code editors
  editorContainer.addEventListener('click', (e) => {
    const line = e.target.closest('.code-line');
    if (!line) return;
    $$('.code-line.active', line.parentElement).forEach((l) => l.classList.remove('active'));
    line.classList.add('active');
    const ln = Array.from(line.parentElement.children).indexOf(line) + 1;
    let col = 1;
    const sel = window.getSelection();
    const content = $('.line-content', line);
    if (sel && sel.rangeCount && content.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.setStart(content, 0);
      r.setEnd(sel.anchorNode, sel.anchorOffset);
      col = r.toString().length + 1;
    }
    $('#status-cursor').textContent = `Ln ${ln}, Col ${col}`;
  });

  // Hover docs
  const hoverWidget = $('#hover-widget');
  let hoverTimer = null;
  function showHover(target) {
    const key = target.dataset.doc;
    const doc = OPTION_DOCS[key];
    if (!doc) return;
    hoverWidget.innerHTML = `<span class="hover-type">${escapeHtml(key)}: ${escapeHtml(doc[0])}</span>${doc[1]}`;
    hoverWidget.hidden = false;
    const r = target.getBoundingClientRect();
    const w = hoverWidget.offsetWidth, h = hoverWidget.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.top - h - 6;
    if (top < 40) top = r.bottom + 6;
    hoverWidget.style.left = `${Math.max(8, left)}px`;
    hoverWidget.style.top = `${top}px`;
  }
  function hideHover() { hoverWidget.hidden = true; }
  editorContainer.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.has-doc');
    clearTimeout(hoverTimer);
    if (!t) { hideHover(); return; }
    hoverTimer = setTimeout(() => showHover(t), 250);
  });
  editorContainer.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); hideHover(); });
  editorContainer.addEventListener('scroll', hideHover, { passive: true });

  // ------------------------------------------------------------------ side bar / activity bar
  const sidebar = $('#sidebar');
  function showView(view, opts = {}) {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    if (view === state.view && !workbench.classList.contains('sidebar-hidden') && !opts.force) {
      if (!opts.keepOpen) workbench.classList.add('sidebar-hidden');
      return;
    }
    state.view = view;
    workbench.classList.remove('sidebar-hidden');
    $$('.activity-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.sidebar-view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
    if (view === 'search') setTimeout(() => $('#site-search').focus(), 50);
    if (narrow && opts.fromNav) { /* leave the overlay open so the user sees it */ }
  }
  $$('.activity-item[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // Pane headers
  document.addEventListener('click', (e) => {
    const header = e.target.closest('.pane-header');
    if (!header || e.target.closest('.pane-actions')) return;
    const pane = header.parentElement;
    pane.classList.toggle('expanded');
    header.setAttribute('aria-expanded', pane.classList.contains('expanded'));
  });

  // Tree interactions
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row || e.target.closest('.row-actions')) return;
    const item = row.parentElement;
    if (item.classList.contains('folder')) {
      item.classList.toggle('expanded');
      item.setAttribute('aria-expanded', item.classList.contains('expanded'));
      return;
    }
    if (item.dataset.file) {
      openFile(item.dataset.file);
      if (window.matchMedia('(max-width: 900px)').matches) workbench.classList.add('sidebar-hidden');
    } else if (item.closest('#remote-tree')) {
      $$('#remote-tree .tree-item').forEach((li) => li.classList.remove('selected'));
      item.classList.add('selected');
      if (item.dataset.remote) {
        openFile(`remote:${item.dataset.remote}`);
        if (window.matchMedia('(max-width: 900px)').matches) workbench.classList.add('sidebar-hidden');
      } else {
        notify(`<strong>View Content</strong> would open <code>${escapeHtml(item.dataset.name)}</code> read-only from the server. In this demo only <code>index.html</code> and <code>css/style.css</code> have content.`, { timeout: 5000 });
      }
    }
  });
  // Collapse-all buttons
  $$('.icon-btn[title="Collapse Folders in Explorer"], .icon-btn[title="Collapse All"]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const pane = b.closest('.pane');
    $$('.tree-item.folder:not(.root)', pane).forEach((li) => li.classList.remove('expanded'));
  }));

  // Remote Explorer context menu (mirrors the extension's real menu)
  $('#remote-tree').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    e.preventDefault();
    const item = row.parentElement;
    $$('#remote-tree .tree-item').forEach((li) => li.classList.remove('selected'));
    item.classList.add('selected');
    const name = item.dataset.name || 'Acme Widgets — production';
    const isFolder = item.classList.contains('folder');
    const demo = (what) => () => notify(`<strong>${what}</strong> on <code>${escapeHtml(name)}</code> — in VS Code this runs against the server. Nothing happens in this demo.`, { timeout: 5000 });
    const items = isFolder ? [
      { label: 'Upload File Here', run: demo('Upload File Here') },
      { label: 'Download Folder', run: () => startTransfers(demoFilesFor(name), 'download') },
      { sep: true },
      { label: 'New File', run: demo('Create File') },
      { label: 'New Folder', run: demo('Create Folder') },
      { label: 'Refresh', run: () => runCommand('sftp.remoteExplorer.refresh') },
      { sep: true },
      { label: 'Delete', run: demo('Delete') },
      { label: 'Rename', run: demo('Rename') },
    ] : [
      { label: 'Edit in Local', run: () => item.dataset.remote ? openFile(`remote:${item.dataset.remote}`) : demo('Edit in Local')() },
      { label: 'Reveal in Explorer', run: () => { showView('explorer', { force: true }); notify(`<strong>Reveal in Explorer</strong> jumps to the local copy of <code>${escapeHtml(name)}</code>.`, { timeout: 4000 }); } },
      { sep: true },
      { label: 'Upload File', run: () => startTransfers([{ name, size: 8_000 + Math.random() * 400_000 }], 'upload') },
      { label: 'Upload File To All Profiles', run: () => startTransfers([{ name: `${name} → staging`, size: 120_000 }, { name: `${name} → prod`, size: 120_000 }], 'upload') },
      { label: 'Download File', run: () => startTransfers([{ name, size: 8_000 + Math.random() * 400_000 }], 'download') },
      { sep: true },
      { label: 'Delete', run: demo('Delete') },
      { label: 'Rename', run: demo('Rename') },
    ];
    openMenu(items, { x: e.clientX, y: e.clientY });
  });

  // ------------------------------------------------------------------ sidebar search
  let searchIndex = null;
  function buildSearchIndex() {
    if (searchIndex) return searchIndex;
    searchIndex = Object.keys(FILES).filter((id) => !id.startsWith('remote:')).map((id) => {
      const tpl = document.getElementById(`editor-${id}`);
      if (!tpl) return null;
      const div = document.createElement('div');
      div.appendChild(tpl.content.cloneNode(true));
      const blocks = $$('h1, h2, h3, p, li, td, pre, .plaintext, .code-source', div)
        .filter((el) => !el.querySelector('p, li, h1, h2, h3, pre'))
        .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return { id, blocks };
    }).filter(Boolean);
    return searchIndex;
  }
  $('#site-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const results = $('#search-results');
    results.textContent = '';
    const hint = (cls, text) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; };
    if (q.length < 2) { results.appendChild(hint('search-hint', 'Type at least two characters.')); return; }
    let total = 0;
    const frag = document.createDocumentFragment();
    buildSearchIndex().forEach(({ id, blocks }) => {
      const matches = blocks.filter((b) => b.toLowerCase().includes(q)).slice(0, 6);
      if (!matches.length) return;
      total += matches.length;
      const f = FILES[id];
      const head = document.createElement('div');
      head.className = 'search-file';
      head.innerHTML = `<svg class="icon twistie" style="transform:rotate(90deg)"><use href="#i-chevron-right"/></svg><span class="file-icon ${f.icon}"></span><span></span><span class="count"></span>`;
      head.children[2].textContent = f.label;
      head.children[3].textContent = String(matches.length);
      frag.appendChild(head);
      matches.forEach((m) => {
        const idx = m.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 30);
        const b = document.createElement('button');
        b.className = 'search-match';
        b.dataset.file = id;
        b.title = m.slice(0, 200);
        if (start > 0) b.append('…');
        b.append(m.slice(start, idx));
        const mark = document.createElement('mark');
        mark.textContent = m.slice(idx, idx + q.length);
        b.appendChild(mark);
        b.append(m.slice(idx + q.length, idx + q.length + 80));
        frag.appendChild(b);
      });
    });
    if (!total) { results.appendChild(hint('search-none', 'No results found.')); return; }
    results.appendChild(hint('search-hint', `${total} result${total === 1 ? '' : 's'}`));
    results.appendChild(frag);
  });

  // ------------------------------------------------------------------ panel
  const panel = $('#panel');
  function showPanel(tab) {
    workbench.classList.remove('panel-hidden');
    if (tab) {
      state.panelTab = tab;
      $$('.panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.panel === tab));
      $$('.panel-view').forEach((v) => v.classList.toggle('active', v.dataset.panel === tab));
      $('#output-channel').hidden = tab !== 'output';
      if (tab === 'terminal') startTerminal(state.activeTerminal || 'install');
    }
  }
  function togglePanel(force) {
    const hide = force === undefined ? !workbench.classList.contains('panel-hidden') : !force;
    workbench.classList.toggle('panel-hidden', hide);
    workbench.classList.remove('panel-maximized');
    if (!hide) showPanel(state.panelTab);
  }
  $$('.panel-tab').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));

  // Terminals
  const TERMINALS = {
    install: {
      title: 'bash — install', icon: '#i-terminal',
      script: [
        { cmd: 'code --install-extension jmwerk.sftpresso' },
        { out: 'Installing extensions...', cls: 'term-dim' },
        { out: "Extension 'jmwerk.sftpresso' v1.34.0 was successfully installed.", cls: 'term-ok' },
        { cmd: 'code .' },
        { out: '# Then run  SFTP: Config  from the Command Palette (Ctrl+Shift+P) to create .vscode/sftp.json', cls: 'term-dim' },
      ],
    },
    vsix: {
      title: 'bash — build from source', icon: '#i-terminal',
      script: [
        { cmd: 'git clone https://github.com/jmwerk/SFTPresso.git' },
        { out: "Cloning into 'SFTPresso'...", cls: 'term-dim' },
        { cmd: 'cd SFTPresso' },
        { cmd: 'npm install', comment: '# also applies bundled patches via patch-package' },
        { out: 'added 812 packages in 9s', cls: 'term-dim' },
        { cmd: 'npm run package', comment: '# produces sftpresso-<version>.vsix via vsce' },
        { out: ' DONE  Packaged: sftpresso-1.34.0.vsix', cls: 'term-ok' },
        { cmd: 'code --install-extension sftpresso-1.34.0.vsix' },
        { out: "Extension 'sftpresso-1.34.0.vsix' was successfully installed.", cls: 'term-ok' },
      ],
    },
    codium: {
      title: 'zsh — VSCodium / Open VSX', icon: '#i-terminal',
      script: [
        { cmd: 'codium --install-extension jmwerk.sftpresso' },
        { out: "Extension 'jmwerk.sftpresso' v1.34.0 was successfully installed.", cls: 'term-ok' },
        { out: '# VSCodium, Gitpod, Eclipse Theia and friends resolve this through Open VSX:', cls: 'term-dim' },
        { out: '# https://open-vsx.org/extension/jmwerk/sftpresso', cls: 'term-info' },
      ],
    },
    ssh: {
      title: 'ssh — acme.example.com', icon: '#i-remote',
      prompt: 'deploy@acme:/var/www/acme$ ',
      script: [
        { out: '# "SFTP: Open SSH in Terminal" opens a terminal already logged in to the active profile:', cls: 'term-dim' },
        { out: 'Last login: Fri Sep 11 09:41:02 2026 from 203.0.113.7', cls: 'term-dim' },
        { cmd: 'ls' },
        { out: 'assets  css  index.html  README.md  src' },
        { cmd: 'sudo systemctl reload php8.3-fpm', comment: '# or: SFTP: Run Remote Command, no re-auth needed' },
      ],
    },
  };
  const terminalInstances = $('#terminal-instances');
  const terminalTabs = $('#terminal-tabs');
  Object.entries(TERMINALS).forEach(([id, t]) => {
    const tab = document.createElement('button');
    tab.className = 'terminal-tab';
    tab.dataset.terminal = id;
    tab.setAttribute('role', 'tab');
    tab.innerHTML = `<svg class="icon"><use href="${t.icon}"/></svg><span>${t.title}</span>`;
    tab.addEventListener('click', () => startTerminal(id));
    terminalTabs.appendChild(tab);
    const el = document.createElement('div');
    el.className = 'terminal';
    el.dataset.terminal = id;
    el.setAttribute('role', 'log');
    terminalInstances.appendChild(el);
  });
  function termPrompt(id) {
    const t = TERMINALS[id];
    if (t.prompt) return `<span class="term-prompt">${escapeHtml(t.prompt)}</span>`;
    return `<span class="term-prompt">~</span><span class="term-path">/projects/acme</span> <span class="term-prompt">$</span> `;
  }
  async function startTerminal(id) {
    state.activeTerminal = id;
    $$('.terminal-tab').forEach((b) => b.classList.toggle('active', b.dataset.terminal === id));
    $$('.terminal').forEach((v) => v.classList.toggle('active', v.dataset.terminal === id));
    if (state.terminals[id]) return;
    state.terminals[id] = true;
    const el = $(`.terminal[data-terminal="${id}"]`);
    const t = TERMINALS[id];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const step of t.script) {
      const line = document.createElement('div');
      line.className = 'term-line';
      el.appendChild(line);
      if (step.cmd) {
        line.innerHTML = termPrompt(id);
        const cmdSpan = document.createElement('span');
        cmdSpan.className = 'term-cmd';
        line.appendChild(cmdSpan);
        const cursor = document.createElement('span');
        cursor.className = 'term-cursor';
        line.appendChild(cursor);
        if (reduced) cmdSpan.textContent = step.cmd;
        else {
          await sleep(200);
          for (const ch of step.cmd) { cmdSpan.textContent += ch; await sleep(18 + Math.random() * 30); }
          await sleep(150);
        }
        cursor.remove();
        if (step.comment) line.insertAdjacentHTML('beforeend', `  <span class="term-dim">${escapeHtml(step.comment)}</span>`);
        const copy = document.createElement('button');
        copy.className = 'term-copy';
        copy.innerHTML = '<svg class="icon"><use href="#i-copy"/></svg>Copy';
        copy.addEventListener('click', () => copyText(step.cmd, copy));
        line.appendChild(copy);
      } else {
        line.innerHTML = `<span class="${step.cls || ''}">${escapeHtml(step.out)}</span>`;
        if (!reduced) await sleep(120);
      }
      el.scrollTop = el.scrollHeight;
    }
    const tail = document.createElement('div');
    tail.className = 'term-line';
    tail.innerHTML = termPrompt(id) + '<span class="term-cursor"></span>';
    el.appendChild(tail);
  }
  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) { const old = button.innerHTML; button.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>Copied'; setTimeout(() => { button.innerHTML = old; }, 1500); }
      else notify('Copied to clipboard.', { timeout: 2000 });
    } catch (e) {
      notify('Clipboard access was blocked — select the text and copy it manually.', { type: 'warning' });
    }
  }

  // ------------------------------------------------------------------ menus
  const contextMenu = $('#context-menu');
  const backdrop = $('#overlay-backdrop');
  function closeMenus() {
    contextMenu.hidden = true;
    backdrop.hidden = true;
    $$('.menubar-item.open').forEach((b) => b.classList.remove('open'));
  }
  function openMenu(items, pos, anchorBtn) {
    contextMenu.innerHTML = '';
    items.forEach((it) => {
      if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; contextMenu.appendChild(s); return; }
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.setAttribute('role', 'menuitem');
      if (it.disabled) b.disabled = true;
      b.innerHTML = `${it.checked ? '<svg class="icon menu-check"><use href="#i-check"/></svg>' : ''}<span>${it.label}</span>${it.key ? `<span class="menu-key">${it.key}</span>` : ''}`;
      b.addEventListener('click', () => { closeMenus(); it.run && it.run(); });
      contextMenu.appendChild(b);
    });
    contextMenu.hidden = false;
    backdrop.hidden = false;
    if (anchorBtn) anchorBtn.classList.add('open');
    const w = contextMenu.offsetWidth, h = contextMenu.offsetHeight;
    contextMenu.style.left = `${Math.max(4, Math.min(pos.x, window.innerWidth - w - 4))}px`;
    contextMenu.style.top = `${Math.max(4, Math.min(pos.y, window.innerHeight - h - 4))}px`;
  }
  backdrop.addEventListener('click', closeMenus);
  backdrop.addEventListener('contextmenu', (e) => { e.preventDefault(); closeMenus(); });

  const open = (url) => window.open(url, '_blank', 'noopener');
  const MENUS = {
    file: () => [
      { label: 'New Text File', key: `${MOD}+N`, disabled: true },
      { label: 'Open Folder…', key: `${MOD}+K ${MOD}+O`, disabled: true },
      { sep: true },
      { label: 'Install SFTPresso from the Marketplace', run: () => open('https://marketplace.visualstudio.com/items?itemName=jmwerk.sftpresso') },
      { label: 'Install from Open VSX', run: () => open('https://open-vsx.org/extension/jmwerk/sftpresso') },
      { label: 'Download a .vsix (Releases)', run: () => open('https://github.com/jmwerk/SFTPresso/releases') },
      { sep: true },
      { label: 'Open sftp.json', run: () => openFile('sftp.json') },
      { sep: true },
      { label: 'Exit', disabled: true },
    ],
    edit: () => [
      { label: 'Undo', key: `${MOD}+Z`, disabled: true }, { label: 'Redo', key: `${MOD}+Y`, disabled: true }, { sep: true },
      { label: 'Cut', key: `${MOD}+X`, disabled: true }, { label: 'Copy', key: `${MOD}+C`, disabled: true }, { label: 'Paste', key: `${MOD}+V`, disabled: true }, { sep: true },
      { label: 'Find in Files', key: `${MOD}+Shift+F`, run: () => showView('search', { force: true }) },
    ],
    selection: () => [
      { label: 'Select All', key: `${MOD}+A`, disabled: true }, { label: 'Expand Selection', disabled: true }, { sep: true },
      { label: 'Add Cursor Above', disabled: true }, { label: 'Add Cursor Below', disabled: true },
    ],
    view: () => [
      { label: 'Command Palette…', key: `${MOD}+Shift+P`, run: () => openQuickInput('>') },
      { sep: true },
      { label: 'Explorer', key: `${MOD}+Shift+E`, run: () => showView('explorer', { force: true }) },
      { label: 'Search', key: `${MOD}+Shift+F`, run: () => showView('search', { force: true }) },
      { label: 'Source Control', key: `${MOD}+Shift+G`, run: () => showView('scm', { force: true }) },
      { label: 'Run and Debug', key: `${MOD}+Shift+D`, run: () => showView('debug', { force: true }) },
      { label: 'Extensions', key: `${MOD}+Shift+X`, run: () => showView('extensions', { force: true }) },
      { label: 'SFTP Remote Explorer', run: () => showView('sftp', { force: true }) },
      { sep: true },
      { label: 'Problems', key: `${MOD}+Shift+M`, run: () => showPanel('problems') },
      { label: 'Output', key: `${MOD}+K ${MOD}+H`, run: () => showPanel('output') },
      { label: 'Terminal', key: `${MOD}+\``, run: () => showPanel('terminal') },
      { sep: true },
      { label: 'Toggle Primary Side Bar', key: `${MOD}+B`, checked: !workbench.classList.contains('sidebar-hidden'), run: () => workbench.classList.toggle('sidebar-hidden') },
      { label: 'Toggle Panel', key: `${MOD}+J`, checked: !workbench.classList.contains('panel-hidden'), run: () => togglePanel() },
      { sep: true },
      { label: 'Color Theme', key: `${MOD}+K ${MOD}+T`, run: toggleTheme },
    ],
    go: () => [
      { label: 'Back', key: 'Alt+←', run: () => history.back() },
      { label: 'Forward', key: 'Alt+→', run: () => history.forward() },
      { sep: true },
      { label: 'Go to File…', key: `${MOD}+P`, run: () => openQuickInput('') },
      { label: 'Go to Symbol in Editor…', key: `${MOD}+Shift+O`, disabled: true },
      { sep: true },
      { label: 'Go to README', run: () => openFile('README.md') },
      { label: 'Go to Quick start', run: () => openFile('quick-start.md') },
      { label: 'Go to Features', run: () => openFile('features.md') },
    ],
    run: () => [
      { label: 'SFTP: Test Connection', run: () => runCommand('sftp.testConnection') },
      { label: 'SFTP: Download Project', run: () => runCommand('sftp.download.project') },
      { label: 'SFTP: Run Remote Command', run: () => runCommand('sftp.runRemoteCommand') },
      { sep: true },
      { label: 'Start Debugging', key: 'F5', disabled: true },
    ],
    terminal: () => [
      { label: 'New Terminal', key: `${MOD}+Shift+\``, run: () => showPanel('terminal') },
      { label: 'Run Task…', disabled: true },
      { sep: true },
      { label: 'SFTP: Open SSH in Terminal', run: () => runCommand('sftp.openConnectInTerminal') },
    ],
    help: () => [
      { label: 'Welcome', run: () => openFile('README.md') },
      { label: 'Documentation (wiki)', run: () => open('https://github.com/jmwerk/SFTPresso/wiki') },
      { label: 'Show All Commands', key: `${MOD}+Shift+P`, run: () => openQuickInput('>') },
      { sep: true },
      { label: 'Report Issue…', run: () => open('https://github.com/jmwerk/SFTPresso/issues/new/choose') },
      { label: 'View Changelog', run: () => openFile('CHANGELOG.md') },
      { label: 'View License', run: () => openFile('LICENSE') },
      { sep: true },
      { label: 'GitHub Repository', run: () => open('https://github.com/jmwerk/SFTPresso') },
      { label: 'About SFTPresso', run: () => openFile('extension') },
    ],
    compact: () => [
      { label: 'Command Palette…', run: () => openQuickInput('>') },
      { label: 'Go to File…', run: () => openQuickInput('') },
      { sep: true },
      { label: 'Install from Marketplace', run: () => open('https://marketplace.visualstudio.com/items?itemName=jmwerk.sftpresso') },
      { label: 'Install from Open VSX', run: () => open('https://open-vsx.org/extension/jmwerk/sftpresso') },
      { label: 'GitHub Repository', run: () => open('https://github.com/jmwerk/SFTPresso') },
      { label: 'Documentation (wiki)', run: () => open('https://github.com/jmwerk/SFTPresso/wiki') },
      { sep: true },
      { label: 'Toggle Panel', run: () => togglePanel() },
      { label: 'Color Theme', run: toggleTheme },
    ],
    accounts: () => [
      { label: 'jmwerk (GitHub)', run: () => open('https://github.com/jmwerk') },
      { label: 'jmwerk (Marketplace publisher)', run: () => open('https://marketplace.visualstudio.com/publishers/jmwerk') },
      { sep: true },
      { label: 'Sponsor the upstream authors…', run: () => open('https://github.com/Natizyskunk/vscode-sftp#donation') },
    ],
    manage: () => [
      { label: 'Command Palette…', key: `${MOD}+Shift+P`, run: () => openQuickInput('>') },
      { sep: true },
      { label: 'Settings (sftp.json)', run: () => openFile('sftp.json') },
      { label: 'Keyboard Shortcuts', run: () => openFile('commands.md', { anchor: undefined }) },
      { label: 'Extensions', run: () => showView('extensions', { force: true }) },
      { sep: true },
      { label: 'Color Theme', run: toggleTheme },
      { sep: true },
      { label: 'Check for Updates… (Releases)', run: () => open('https://github.com/jmwerk/SFTPresso/releases') },
    ],
  };
  $$('[data-menu]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = btn.classList.contains('open');
    closeMenus();
    if (wasOpen) return;
    const r = btn.getBoundingClientRect();
    const pos = btn.classList.contains('activity-item') ? { x: r.right + 4, y: r.top - 120 } : { x: r.left, y: r.bottom + 2 };
    openMenu(MENUS[btn.dataset.menu](), pos, btn);
  }));
  // Hover-switch between menubar menus while one is open
  $$('.menubar-item').forEach((btn) => btn.addEventListener('mouseenter', () => {
    if ($('.menubar-item.open') && !btn.classList.contains('open')) btn.click();
  }));

  // ------------------------------------------------------------------ commands
  const COMMANDS = [
    { id: 'sftp.config', label: 'SFTP: Config', desc: 'Open or create .vscode/sftp.json', run: () => openFile('sftp.json') },
    { id: 'sftp.setProfile', label: 'SFTP: Set Profile', desc: 'Switch the active profile', run: pickProfile },
    { id: 'sftp.testConnection', label: 'SFTP: Test Connection', desc: 'Connect with the active profile', run: testConnection },
    { id: 'sftp.disconnect', label: 'SFTP: Disconnect', desc: 'Drop every pooled connection', run: () => { setConnection('idle'); logOutput('info', 'disconnected all pooled connections'); notify('All connections closed. The next command reconnects fresh.', { timeout: 3000 }); } },
    { id: 'sftp.toggleUploadOnSave', label: 'SFTP: Toggle Upload on Save', desc: 'Flip uploadOnSave in sftp.json', run: toggleUploadOnSave },
    { id: 'sftp.openConnectInTerminal', label: 'SFTP: Open SSH in Terminal', desc: 'Open a terminal logged in to the server', run: () => { showPanel('terminal'); startTerminal('ssh'); } },
    { id: 'sftp.runRemoteCommand', label: 'SFTP: Run Remote Command', desc: 'Run a shell command over the existing SSH connection', run: pickRemoteCommand },
    { id: 'sftp.savePassword', label: 'SFTP: Save Password', desc: 'Store a password in the OS keychain', run: () => notify('In VS Code this stores the password in secret storage (your OS keychain), keyed by <code>protocol://user@host:port</code>. Nothing is stored here.', { timeout: 6000 }) },
    { id: 'sftp.migratePassword', label: 'SFTP: Migrate Plaintext Password', desc: 'Move a password out of sftp.json into secret storage', run: () => openFile('security.md') },
    { id: 'sftp.showHostKey', label: 'SFTP: Show Host Key Fingerprint', desc: 'Show the stored host key for a remote', run: () => notify('<strong>acme.example.com</strong> — ssh-ed25519<br><code>SHA256:mAqi5TQdE7Ykq3lJMCFkR0ulQjB3AGHFKDwjPnIcpzE</code><br>from ~/.ssh/known_hosts:14', { actions: [{ label: 'Copy', run: () => copyText('SHA256:mAqi5TQdE7Ykq3lJMCFkR0ulQjB3AGHFKDwjPnIcpzE') }], timeout: 9000 }) },
    { id: 'sftp.forgetHostKey', label: 'SFTP: Forget Host Key', desc: 'Clear a stored host key', run: () => openFile('security.md') },
    { id: 'sftp.upload.activeFile', label: 'SFTP: Upload Active File', desc: 'Upload the file open in the editor', run: () => startTransfers([{ name: FILES[state.active] ? FILES[state.active].label : 'index.html', size: 12_000 + Math.random() * 200_000 }], 'upload') },
    { id: 'sftp.upload.project', label: 'SFTP: Upload Project', desc: 'Upload the whole project', run: () => startTransfers(demoFilesFor('project'), 'upload') },
    { id: 'sftp.upload.changedFiles', label: 'SFTP: Upload Changed Files', desc: 'Upload everything changed since the last commit', key: ['Ctrl', 'Alt', 'U'], run: () => startTransfers(demoFilesFor('changed'), 'upload') },
    { id: 'sftp.download.project', label: 'SFTP: Download Project', desc: 'Download everything under remotePath', run: () => startTransfers(demoFilesFor('project'), 'download') },
    { id: 'sftp.sync.localToRemote', label: 'SFTP: Sync Local -> Remote', desc: 'Copy files that differ by timestamp', run: syncPreview },
    { id: 'sftp.diff.activeFile', label: 'SFTP: Diff Active File with Remote', desc: "Open VS Code's diff view", run: () => notify('In VS Code this opens the built-in diff editor: your local file on the left, the remote copy on the right.', { timeout: 5000 }) },
    { id: 'sftp.compareFolders', label: 'SFTP: Compare Folders with Remote', desc: 'Recursive local/remote diff', run: () => openFile('features.md', { anchor: 'feat-explore' }) },
    { id: 'sftp.remoteExplorer.filter', label: 'SFTP: Filter Remote Explorer', desc: 'Live substring search across the remote tree', run: () => { showView('sftp', { force: true }); openQuickInput('filter:'); } },
    { id: 'sftp.remoteExplorer.clearFilter', label: 'SFTP: Clear Filter', desc: 'Restore the full remote listing', run: () => applyRemoteFilter('') },
    { id: 'sftp.remoteExplorer.refresh', label: 'SFTP: Refresh Remote Explorer', desc: '', run: () => { showView('sftp', { force: true }); logOutput('debug', 'remote explorer refreshed (acme.example.com)'); } },
    { id: 'sftp.cancelAllTransfer', label: 'SFTP: Cancel All Transfers', desc: 'Stop every in-flight transfer', run: cancelAllTransfers },
    { id: 'workbench.action.showCommands', label: 'Show All Commands', desc: '', key: [MOD, 'Shift', 'P'], run: () => openQuickInput('>') },
    { id: 'workbench.action.quickOpen', label: 'Go to File…', desc: '', key: [MOD, 'P'], run: () => openQuickInput('') },
    { id: 'workbench.action.toggleSidebar', label: 'View: Toggle Primary Side Bar Visibility', desc: '', key: [MOD, 'B'], run: () => workbench.classList.toggle('sidebar-hidden') },
    { id: 'workbench.action.togglePanel', label: 'View: Toggle Panel Visibility', desc: '', key: [MOD, 'J'], run: () => togglePanel() },
    { id: 'workbench.action.terminal', label: 'Terminal: Focus Terminal', desc: '', key: [MOD, '`'], run: () => showPanel('terminal') },
    { id: 'workbench.action.output', label: 'Output: Show Output Channels…', desc: '', run: () => showPanel('output') },
    { id: 'workbench.action.selectTheme', label: 'Preferences: Color Theme', desc: 'Dark Modern ↔ Light Modern', key: [MOD, 'K', MOD, 'T'], run: toggleTheme },
    { id: 'workbench.extensions.install', label: 'Extensions: Install Extension… (SFTPresso)', desc: 'jmwerk.sftpresso', run: () => openFile('extension') },
    { id: 'workbench.action.openWalkthrough', label: 'Welcome: Open Walkthrough… (Get started with SFTPresso)', desc: '', run: () => openFile('quick-start.md') },
    { id: 'workbench.action.openIssue', label: 'Help: Report Issue…', desc: '', run: () => open('https://github.com/jmwerk/SFTPresso/issues/new/choose') },
    { id: 'workbench.action.openWiki', label: 'Help: Documentation (SFTPresso wiki)', desc: '', run: () => open('https://github.com/jmwerk/SFTPresso/wiki') },
  ];
  function runCommand(id) {
    const c = COMMANDS.find((x) => x.id === id);
    if (c) c.run();
  }

  // Connection state
  function setConnection(stateName) {
    state.connection = stateName;
    const item = $('#status-connection');
    const use = $('use', item);
    const icon = $('.icon', item);
    item.classList.remove('is-error', 'is-connected');
    icon.classList.remove('spin');
    if (stateName === 'connecting') { use.setAttribute('href', '#i-loading'); icon.classList.add('spin'); item.title = 'SFTP: connecting…'; }
    else if (stateName === 'connected') { use.setAttribute('href', '#i-vm-active'); item.classList.add('is-connected'); item.title = 'SFTP: connected to ' + activeHost() + ' — click to test again'; }
    else if (stateName === 'error') { use.setAttribute('href', '#i-error'); item.classList.add('is-error'); item.title = 'SFTP: connection failed — click to retry'; }
    else { use.setAttribute('href', '#i-plug'); item.title = 'SFTP: idle — click to test the connection'; }
  }
  function activeHost() { return state.profile === 'prod' ? 'acme.example.com' : state.profile === 'staging' ? 'staging.example.com' : 'acme.example.com'; }
  let connecting = false;
  async function testConnection() {
    if (connecting) return;
    connecting = true;
    const host = activeHost();
    setConnection('connecting');
    showPanel('output');
    logOutput('info', `[${state.profile}] connecting to sftp://deploy@${host}:22 …`);
    await sleep(500);
    logOutput('debug', `host key ssh-ed25519 SHA256:mAqi5TQdE7Ykq3lJMCFkR0ulQjB3AGHFKDwjPnIcpzE matches ~/.ssh/known_hosts:14`);
    await sleep(350);
    logOutput('debug', 'authenticating with private key /Users/me/.ssh/id_ed25519');
    await sleep(500);
    logOutput('info', `[${state.profile}] connected — remotePath ${state.profile === 'staging' ? '/var/www/staging' : '/var/www/acme'} is readable`);
    setConnection('connected');
    notify(`Connection to <strong>${host}</strong> succeeded (sftp, deploy, key auth).`, { timeout: 5000 });
    connecting = false;
  }
  function toggleUploadOnSave() {
    state.uploadOnSave = !state.uploadOnSave;
    const item = $('#status-upload-on-save');
    item.classList.toggle('is-off', !state.uploadOnSave);
    item.title = `Upload on Save: ${state.uploadOnSave ? 'On' : 'Off'}`;
    logOutput('info', `uploadOnSave set to ${state.uploadOnSave} in .vscode/sftp.json (comments and formatting preserved)`);
    if (editorInstances['sftp.json']) $$('.code-editor', editorInstances['sftp.json']).forEach(renderCodeEditor);
  }
  function setProfile(name) {
    state.profile = name;
    $('#status-profile span').textContent = name ? `SFTP: ${name}` : 'SFTP: (no profile)';
    setConnection('idle');
    logOutput('info', `active profile → ${name || '(none)'} (${activeHost()})`);
    if (editorInstances['sftp.json']) $$('.code-editor', editorInstances['sftp.json']).forEach(renderCodeEditor);
    $('#remote-tree .root > .tree-row .tree-desc').textContent = `sftp://${activeHost()}`;
    $('#remote-tree .root > .tree-row .tree-label').textContent = `Acme Widgets — ${name === 'prod' ? 'production' : name || 'default'}`;
  }
  function pickProfile() {
    openQuickPick('Select a profile', [
      { label: 'staging', desc: 'staging.example.com — /var/www/staging', run: () => setProfile('staging') },
      { label: 'prod', desc: 'acme.example.com — uploadOnSave: false', run: () => setProfile('prod') },
    ], { current: state.profile });
  }
  function pickRemoteCommand() {
    const run = (label, cmd, output) => () => notify(`Run <code>${escapeHtml(cmd)}</code> on <strong>${activeHost()}</strong>?`, {
      type: 'warning', timeout: 0,
      actions: [{ label: 'Run', run: async () => {
        showPanel('output');
        logOutput('info', `$ ${cmd}   (${activeHost()})`);
        await sleep(600);
        output.forEach((l) => logOutput('info', l));
        logOutput('info', `command exited with code 0`);
      } }, { label: 'Cancel' }],
    });
    openQuickPick('Run a remote command over the existing SSH connection', [
      { label: 'Restart PHP', desc: 'sudo systemctl reload php8.3-fpm', run: run('Restart PHP', 'sudo systemctl reload php8.3-fpm', ['(no output)']) },
      { label: 'Clear cache', desc: 'php artisan cache:clear', run: run('Clear cache', 'php artisan cache:clear', ['   INFO  Application cache cleared successfully.']) },
      { label: 'Type a command…', desc: 'anything the server\'s shell accepts', run: run('custom', 'uptime', [' 09:41:07 up 41 days,  3:12,  1 user,  load average: 0.08, 0.05, 0.01']) },
    ]);
  }
  function syncPreview() {
    notify('<strong>Sync Local → Remote</strong> (dry run): 3 uploads, 1 overwrite, 2 deletions.<br><code>css/style.css</code>, <code>index.html</code>, <code>src/app.js</code> ↑ · <code>assets/img/old-hero.png</code>, <code>tmp/cache.bin</code> ✕<br>Proceed?', {
      type: 'warning', timeout: 0,
      actions: [{ label: 'Proceed', run: () => startTransfers(demoFilesFor('changed'), 'upload') }, { label: 'Cancel' }],
    });
  }

  // Transfers
  function demoFilesFor(kind) {
    const project = [
      ['index.html', 6_120], ['css/style.css', 18_400], ['src/app.js', 84_200], ['assets/img/logo.svg', 4_090], ['assets/img/hero.webp', 612_000],
      ['assets/video/intro.mp4', 9_400_000], ['assets/video/tour.mp4', 14_800_000], ['README.md', 3_200], ['.htaccess', 410], ['src/vendor/lib.min.js', 302_000], ['docs/manual.pdf', 2_100_000], ['assets/fonts/Inter.woff2', 98_000],
    ];
    const changed = [['index.html', 6_120], ['css/style.css', 18_400], ['src/app.js', 84_200]];
    const list = kind === 'changed' ? changed : kind === 'project' ? project : kind === 'assets' ? project.filter(([n]) => n.startsWith('assets/')) : project.slice(0, 5);
    return list.map(([name, size]) => ({ name, size }));
  }
  const transfersList = $('#transfers-list');
  function startTransfers(files, direction) {
    if (!files.length) return;
    showView('sftp', { force: true, keepOpen: true });
    if (!state.transfers.length) transfersList.innerHTML = '';
    const batchId = Date.now();
    files.forEach((f, i) => {
      const t = { id: `${batchId}-${i}`, name: f.name, size: f.size, done: 0, status: 'queued', direction, speed: 0, start: 0, samples: [] };
      state.transfers.push(t);
      const li = document.createElement('li');
      li.className = 'transfer';
      li.dataset.id = t.id;
      li.innerHTML = `<div class="transfer-row"><svg class="icon"><use href="#i-clock"/></svg><span class="transfer-name">${escapeHtml(t.name)}</span><span class="transfer-status">queued</span><span class="transfer-actions"><button class="icon-btn" title="Cancel Transfer"><svg class="icon"><use href="#i-close"/></svg></button></span></div><div class="transfer-bar"><span></span></div>`;
      $('.transfer-actions button', li).addEventListener('click', () => cancelTransfer(t.id));
      transfersList.appendChild(li);
    });
    logOutput('info', `${direction === 'upload' ? 'upload' : 'download'}: ${files.length} file${files.length === 1 ? '' : 's'} queued (concurrency 4, transferMode auto)`);
    if (!state.transferTimer) state.transferTimer = setInterval(tickTransfers, 250);
    if (!state.batchToast) {
      state.batchToast = notify('', { progress: true, timeout: 0, actions: [{ label: 'Cancel', run: cancelAllTransfers }] });
      state.batchToast.setMessage(`${direction === 'upload' ? 'Uploading' : 'Downloading'} ${files.length} files…`);
    }
    updateTransfersStatus();
  }
  function formatBytes(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
    return `${Math.round(n)} B`;
  }
  function tickTransfers() {
    const active = state.transfers.filter((t) => t.status === 'transferring');
    const queued = state.transfers.filter((t) => t.status === 'queued');
    while (active.length < 4 && queued.length) {
      const t = queued.shift();
      t.status = 'transferring';
      t.start = performance.now();
      t.speed = (t.size > 256_000 ? 2.2 : 0.9) * (0.7 + Math.random() * 0.8) * 1_000_000; // bytes/s
      active.push(t);
      const li = $(`.transfer[data-id="${t.id}"]`);
      if (li) $('use', li).setAttribute('href', '#i-sync');
      if (li) $('.icon', li).classList.add('spin');
    }
    let totalSpeed = 0;
    active.forEach((t) => {
      t.speed *= 0.9 + Math.random() * 0.2;
      t.done = Math.min(t.size, t.done + t.speed * 0.25);
      totalSpeed += t.speed;
      const li = $(`.transfer[data-id="${t.id}"]`);
      if (!li) return;
      const pct = t.done / t.size;
      $('.transfer-bar span', li).style.width = `${pct * 100}%`;
      const eta = t.speed > 0 ? Math.max(0, Math.round((t.size - t.done) / t.speed)) : 0;
      const etaStr = `${String(Math.floor(eta / 60)).padStart(2, '0')}:${String(eta % 60).padStart(2, '0')}`;
      $('.transfer-status', li).textContent = `${Math.round(pct * 100)}% — ${formatBytes(t.done)} / ${formatBytes(t.size)} — ${formatBytes(t.speed)}/s — ETA ${etaStr}`;
      if (t.done >= t.size) {
        t.status = 'done';
        li.classList.add('done');
        $('.icon', li).classList.remove('spin');
        $('use', li).setAttribute('href', '#i-check');
        $('.transfer-status', li).textContent = `${formatBytes(t.size)} — done`;
        $('.transfer-actions', li).remove();
        logOutput('info', `${t.direction === 'upload' ? '↑' : '↓'} ${t.name} (${formatBytes(t.size)}) ok`);
        setTimeout(() => { li.remove(); state.transfers = state.transfers.filter((x) => x !== t); updateTransfersStatus(); }, 2500);
      }
    });
    const remaining = state.transfers.filter((t) => t.status === 'queued' || t.status === 'transferring');
    updateTransfersStatus(totalSpeed);
    if (!remaining.length) {
      clearInterval(state.transferTimer);
      state.transferTimer = null;
      if (state.batchToast) { state.batchToast.dismiss(); state.batchToast = null; }
      const n = state.transfers.filter((t) => t.status === 'done').length;
      if (n) notify(`${n} file${n === 1 ? '' : 's'} transferred. Remote Explorer refreshed.`, { timeout: 4000 });
      setConnection('connected');
    }
  }
  function updateTransfersStatus(totalSpeed) {
    const remaining = state.transfers.filter((t) => t.status === 'queued' || t.status === 'transferring');
    const total = state.transfers.length;
    const item = $('#status-transfers');
    const badge = $('#transfers-badge');
    if (!remaining.length) { item.hidden = true; badge.hidden = true; return; }
    item.hidden = false;
    $('#status-transfers-label').textContent = `Transferring ${total - remaining.length + 1}/${total} files${totalSpeed ? ` — ${formatBytes(totalSpeed)}/s` : ''}`;
    item.title = 'Click to cancel all transfers';
    badge.hidden = false;
    badge.textContent = remaining.length;
    if (state.batchToast) {
      state.batchToast.setProgress((total - remaining.length) / total);
      state.batchToast.setMessage(`${remaining[0].direction === 'upload' ? 'Uploading' : 'Downloading'} ${total} files — ${total - remaining.length} done, 0 failed`);
    }
  }
  function cancelTransfer(id) {
    const t = state.transfers.find((x) => x.id === id);
    if (!t || t.status === 'done') return;
    t.status = 'failed';
    const li = $(`.transfer[data-id="${id}"]`);
    if (li) {
      li.classList.add('failed');
      $('.icon', li).classList.remove('spin');
      $('use', li).setAttribute('href', '#i-error');
      $('.transfer-status', li).textContent = 'cancelled';
      const actions = $('.transfer-actions', li);
      actions.innerHTML = `<button class="icon-btn" title="Retry Transfer"><svg class="icon"><use href="#i-refresh"/></svg></button>`;
      $('button', actions).addEventListener('click', () => { t.status = 'queued'; t.done = 0; li.classList.remove('failed'); $('use', li).setAttribute('href', '#i-clock'); $('.transfer-status', li).textContent = 'queued'; actions.innerHTML = `<button class="icon-btn" title="Cancel Transfer"><svg class="icon"><use href="#i-close"/></svg></button>`; $('button', actions).addEventListener('click', () => cancelTransfer(id)); if (!state.transferTimer) state.transferTimer = setInterval(tickTransfers, 250); });
    }
    logOutput('warn', `${t.name}: cancelled`);
  }
  function cancelAllTransfers() {
    const remaining = state.transfers.filter((t) => t.status === 'queued' || t.status === 'transferring');
    if (!remaining.length) { notify('No transfers in progress.', { timeout: 2500 }); return; }
    remaining.forEach((t) => cancelTransfer(t.id));
    logOutput('warn', `cancelled ${remaining.length} transfer${remaining.length === 1 ? '' : 's'} — directory scan stopped too`);
    if (state.batchToast) { state.batchToast.dismiss(); state.batchToast = null; }
    clearInterval(state.transferTimer); state.transferTimer = null;
    updateTransfersStatus();
    notify(`Cancelled ${remaining.length} transfer${remaining.length === 1 ? '' : 's'}. Failed rows keep a ↻ Retry button.`, { type: 'warning', timeout: 5000 });
  }

  // Remote explorer filter
  function applyRemoteFilter(q) {
    state.filter = q;
    const tree = $('#remote-tree');
    const label = $('#remote-filter-label');
    label.textContent = q ? `filter: ${q}` : '';
    $$('.tree-item', tree).forEach((li) => li.classList.remove('hidden-by-filter'));
    if (!q) return;
    const lower = q.toLowerCase();
    $$('.tree-item:not(.root)', tree).forEach((li) => {
      const name = (li.dataset.name || '').toLowerCase();
      const selfMatch = name.includes(lower);
      const descendantMatch = $$('.tree-item', li).some((d) => (d.dataset.name || '').toLowerCase().includes(lower));
      if (!selfMatch && !descendantMatch) li.classList.add('hidden-by-filter');
      if (descendantMatch && li.classList.contains('folder')) li.classList.add('expanded');
    });
  }

  // ------------------------------------------------------------------ quick input
  const quickInput = $('#quick-input');
  const quickField = $('#quick-input-field');
  const quickList = $('#quick-input-list');
  let quick = { mode: 'files', items: [], focused: 0, onPick: null, onLive: null };
  function openQuickInput(prefix) {
    quickInput.hidden = false;
    backdrop.hidden = false;
    contextMenu.hidden = true;
    quick = { mode: prefix === '>' ? 'commands' : prefix === 'filter:' ? 'filter' : 'files', items: [], focused: 0, onPick: null, onLive: prefix === 'filter:' ? applyRemoteFilter : null };
    quickField.value = prefix === 'filter:' ? state.filter : prefix;
    quickField.placeholder = prefix === 'filter:' ? 'Filter the Remote Explorer by name (live)' : 'Search files by name (append > to search commands)';
    renderQuick();
    quickField.focus();
    quickField.setSelectionRange(quickField.value.length, quickField.value.length);
  }
  function openQuickPick(placeholder, items, opts = {}) {
    quickInput.hidden = false;
    backdrop.hidden = false;
    contextMenu.hidden = true;
    quick = { mode: 'pick', items, focused: Math.max(0, items.findIndex((i) => i.label === opts.current)), onPick: null };
    quickField.value = '';
    quickField.placeholder = placeholder;
    renderQuick();
    quickField.focus();
  }
  function closeQuickInput() { quickInput.hidden = true; backdrop.hidden = true; }
  function fuzzyMatch(q, text) {
    if (!q) return { score: 1, html: escapeHtml(text) };
    const lt = text.toLowerCase(), lq = q.toLowerCase();
    const idx = lt.indexOf(lq);
    if (idx !== -1) return { score: 100 - idx, html: escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(text.slice(idx + q.length)) };
    // subsequence match
    let ti = 0, out = '', score = 0;
    for (let qi = 0; qi < lq.length; qi++) {
      const pos = lt.indexOf(lq[qi], ti);
      if (pos === -1) return null;
      out += escapeHtml(text.slice(ti, pos)) + '<mark>' + escapeHtml(text[pos]) + '</mark>';
      score += pos === ti ? 3 : 1;
      ti = pos + 1;
    }
    return { score, html: out + escapeHtml(text.slice(ti)) };
  }
  function renderQuick() {
    const raw = quickField.value;
    let items = [];
    if (quick.mode === 'pick') {
      items = quick.items.map((i) => ({ ...i, html: escapeHtml(i.label) }));
    } else if (quick.mode === 'filter') {
      items = [{ label: raw ? `Filter Remote Explorer by "${raw}"` : 'Clear filter', html: raw ? `Filter Remote Explorer by "<mark>${escapeHtml(raw)}</mark>"` : 'Clear filter', run: () => applyRemoteFilter(raw) }];
      if (quick.onLive) quick.onLive(raw);
    } else if (raw.startsWith('>')) {
      quick.mode = 'commands';
      const q = raw.slice(1).trim();
      items = COMMANDS.map((c) => { const m = fuzzyMatch(q, c.label); return m && { ...c, html: m.html, score: m.score }; }).filter(Boolean).sort((a, b) => b.score - a.score);
    } else {
      quick.mode = 'files';
      const q = raw.trim();
      items = Object.keys(FILES).filter((id) => !id.startsWith('remote:')).map((id) => {
        const f = FILES[id];
        const m = fuzzyMatch(q, f.label);
        return m && { id, label: f.label, desc: f.path.slice(0, -1).join('/'), icon: f.icon, html: m.html, score: m.score, run: () => openFile(id) };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      if (!q) items.unshift({ label: '> Show and Run Commands', html: '<span class="term-dim">&gt;</span> Show and Run Commands', desc: `${MOD}+Shift+P`, run: () => { openQuickInput('>'); }, keepOpen: true });
    }
    quick.items = items;
    quick.focused = Math.min(quick.focused, Math.max(0, items.length - 1));
    quickList.innerHTML = items.length ? items.map((it, i) => `
      <li class="quick-item${i === quick.focused ? ' focused' : ''}" data-index="${i}" role="option" aria-selected="${i === quick.focused}">
        ${it.icon ? `<span class="file-icon ${it.icon}"></span>` : quick.mode === 'commands' ? '' : ''}
        <span class="quick-label">${it.html}</span>
        ${it.desc ? `<span class="quick-desc">${escapeHtml(it.desc)}</span>` : ''}
        ${it.key ? `<span class="quick-key">${it.key.map((k) => `<kbd>${k}</kbd>`).join('')}</span>` : ''}
      </li>`).join('') : '<li class="quick-empty">No matching results</li>';
    const focused = $('.quick-item.focused', quickList);
    if (focused) focused.scrollIntoView({ block: 'nearest' });
  }
  function acceptQuick(index) {
    const it = quick.items[index === undefined ? quick.focused : index];
    if (!it) { closeQuickInput(); return; }
    if (!it.keepOpen) closeQuickInput();
    it.run && it.run();
    if (it.keepOpen) return;
    if (quick.mode === 'files' && window.matchMedia('(max-width: 900px)').matches) workbench.classList.add('sidebar-hidden');
  }
  quickField.addEventListener('input', () => { quick.focused = 0; renderQuick(); });
  quickField.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); quick.focused = (quick.focused + 1) % Math.max(1, quick.items.length); renderQuick(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); quick.focused = (quick.focused - 1 + quick.items.length) % Math.max(1, quick.items.length); renderQuick(); }
    else if (e.key === 'Enter') { e.preventDefault(); acceptQuick(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeQuickInput(); }
  });
  quickList.addEventListener('click', (e) => { const li = e.target.closest('.quick-item'); if (li) acceptQuick(Number(li.dataset.index)); });
  quickList.addEventListener('mousemove', (e) => { const li = e.target.closest('.quick-item'); if (li && Number(li.dataset.index) !== quick.focused) { quick.focused = Number(li.dataset.index); $$('.quick-item', quickList).forEach((x) => x.classList.toggle('focused', x === li)); } });
  $('#command-center').addEventListener('click', () => openQuickInput('>'));

  // ------------------------------------------------------------------ global click handlers (data-* attributes)
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-file], [data-command], [data-open-url], [data-panel-open], [data-view-open], [data-action], [data-copy], [data-copy-source]');
    if (!t || t.closest('.tree-item') || t.closest('.ext-card') && !t.dataset.file) return;
    if (t.dataset.file && !t.closest('.search-match')) { e.preventDefault(); openFile(t.dataset.file, { anchor: t.dataset.anchor }); return; }
    if (t.classList.contains('search-match')) { openFile(t.dataset.file); if (window.matchMedia('(max-width: 900px)').matches) workbench.classList.add('sidebar-hidden'); return; }
    if (t.dataset.command) { e.stopPropagation(); runCommand(t.dataset.command); return; }
    if (t.dataset.openUrl) { open(t.dataset.openUrl); return; }
    if (t.dataset.panelOpen) { showPanel(t.dataset.panelOpen); return; }
    if (t.dataset.viewOpen) { showView(t.dataset.viewOpen, { force: true }); return; }
    if (t.dataset.copy !== undefined) { copyText(t.dataset.copy); return; }
    if (t.dataset.copySource) { const pre = document.getElementById(t.dataset.copySource); copyText(pre.dataset.source || pre.textContent, t); return; }
    switch (t.dataset.action) {
      case 'toggle-sidebar': workbench.classList.toggle('sidebar-hidden'); break;
      case 'toggle-panel': togglePanel(); break;
      case 'toggle-panel-max': workbench.classList.toggle('panel-maximized'); $('use', t).setAttribute('href', workbench.classList.contains('panel-maximized') ? '#i-chevron-down' : '#i-chevron-right'); t.title = workbench.classList.contains('panel-maximized') ? 'Restore Panel Size' : 'Maximize Panel Size'; break;
      case 'toggle-theme': toggleTheme(); break;
      default: break;
    }
  });
  $('#status-transfers').addEventListener('click', (e) => { e.stopPropagation(); cancelAllTransfers(); });
  $('#status-bell').addEventListener('click', () => {
    if ($('.toast', notifications)) { $$('.toast', notifications).forEach((t) => t.remove()); return; }
    notify('No new notifications. Try <strong>SFTP: Test Connection</strong> or <strong>SFTP: Download Project</strong> from the Command Palette.', { timeout: 4000 });
  });

  // ------------------------------------------------------------------ keyboard shortcuts
  let chordK = false;
  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const inField = /input|textarea|select/i.test(e.target.tagName) && e.target !== quickField;
    if (e.key === 'Escape') { closeQuickInput(); closeMenus(); hideHover(); if (window.matchMedia('(max-width: 900px)').matches && !workbench.classList.contains('sidebar-hidden')) workbench.classList.add('sidebar-hidden'); return; }
    if (chordK && mod && e.key.toLowerCase() === 't') { e.preventDefault(); chordK = false; toggleTheme(); return; }
    chordK = false;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (e.shiftKey && key === 'p') { e.preventDefault(); openQuickInput('>'); }
    else if (!e.shiftKey && key === 'p') { e.preventDefault(); openQuickInput(''); }
    else if (!e.shiftKey && key === 'b' && !inField) { e.preventDefault(); workbench.classList.toggle('sidebar-hidden'); }
    else if (!e.shiftKey && key === 'j' && !inField) { e.preventDefault(); togglePanel(); }
    else if (key === '`') { e.preventDefault(); if (!workbench.classList.contains('panel-hidden') && state.panelTab === 'terminal') togglePanel(false); else showPanel('terminal'); }
    else if (e.shiftKey && key === 'e') { e.preventDefault(); showView('explorer', { force: true }); }
    else if (e.shiftKey && key === 'f') { e.preventDefault(); showView('search', { force: true }); }
    else if (e.shiftKey && key === 'g') { e.preventDefault(); showView('scm', { force: true }); }
    else if (e.shiftKey && key === 'd') { e.preventDefault(); showView('debug', { force: true }); }
    else if (e.shiftKey && key === 'x') { e.preventDefault(); showView('extensions', { force: true }); }
    else if (e.shiftKey && key === 'm') { e.preventDefault(); showPanel('problems'); }
    else if (!e.shiftKey && key === 'w' && !inField) { e.preventDefault(); if (state.active) closeFile(state.active); }
    else if (!e.shiftKey && key === 'k') { chordK = true; }
    else if (e.altKey && key === 'u') { e.preventDefault(); runCommand('sftp.upload.changedFiles'); }
  });

  // ------------------------------------------------------------------ sashes
  function initSash(el, axis) {
    let start = 0, startSize = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      start = axis === 'x' ? e.clientX : e.clientY;
      startSize = axis === 'x' ? sidebar.getBoundingClientRect().width : panel.getBoundingClientRect().height;
      const move = (ev) => {
        const delta = axis === 'x' ? ev.clientX - start : start - ev.clientY;
        if (axis === 'x') workbench.style.setProperty('--sidebar-w', `${Math.max(170, Math.min(window.innerWidth * 0.6, startSize + delta))}px`);
        else workbench.style.setProperty('--panel-h', `${Math.max(120, Math.min(window.innerHeight * 0.8, startSize + delta))}px`);
      };
      const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }
  initSash($('#sidebar-sash'), 'x');
  initSash($('#panel-sash'), 'y');

  // ------------------------------------------------------------------ routing
  function fileFromHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!h) return 'README.md';
    if (FILES[h]) return h;
    const [file, anchor] = h.split('/');
    if (FILES[file]) return { file, anchor };
    // legacy-ish aliases
    const alias = { features: 'features.md', install: 'extension', quickstart: 'quick-start.md', 'quick-start': 'quick-start.md', config: 'sftp.json', commands: 'commands.md', workflows: 'workflows.md', security: 'security.md', changelog: 'CHANGELOG.md', license: 'LICENSE' }[h.toLowerCase()];
    return alias || 'README.md';
  }
  window.addEventListener('popstate', () => {
    const target = fileFromHash();
    const id = typeof target === 'string' ? target : target.file;
    openFile(id, { silent: true, anchor: typeof target === 'string' ? undefined : target.anchor });
  });

  // ------------------------------------------------------------------ boot
  function boot() {
    logOutput('info', 'SFTPresso 1.34.0 activated — workspace contains .vscode/sftp.json');
    logOutput('info', 'config "Acme Widgets" loaded — profiles: staging, prod (active: staging)');
    logOutput('debug', 'known_hosts: 14 entries read from ~/.ssh/known_hosts, 0 from extension store');
    logOutput('debug', 'watcher: watching dist/**/* (autoUpload, autoRename)');
    logOutput('info', 'this is a demo workbench on GitHub Pages — nothing here talks to a real server');

    const initial = fileFromHash();
    const initialId = typeof initial === 'string' ? initial : initial.file;
    // Keep README open as the "welcome" tab and open the routed file next to it.
    if (initialId !== 'README.md') state.tabs.push('README.md');
    openFile(initialId, { silent: true, anchor: typeof initial === 'string' ? undefined : initial.anchor });
    history.replaceState({ file: initialId }, '');

    const narrow = window.matchMedia('(max-width: 900px)').matches;
    if (narrow) { workbench.classList.add('sidebar-hidden'); workbench.classList.add('panel-hidden'); }
    else startTerminal('install');

    setConnection('idle');
    $('#status-upload-on-save').classList.toggle('is-off', !state.uploadOnSave);
  }
  boot();
})();
