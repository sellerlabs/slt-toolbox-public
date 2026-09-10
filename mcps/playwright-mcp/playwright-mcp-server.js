/**
 * playwright-mcp-server.js
 *
 * Custom shared Playwright MCP HTTP server.
 *
 * Strategy:
 *   1. Launch ONE real Chrome window using the persistent 'visible-primary' profile
 *   2. For each SSE connection (Claude Code session), createSessionContextFactory()
 *      returns a proxy of the shared BrowserContext that is scoped to that session:
 *        - pages() returns only THIS session's pages (so Context doesn't adopt other sessions' tabs)
 *        - newPage() creates a real page and tracks it as owned by this session
 *        - on('page', ...) fires only when THIS session creates a page
 *        - close() closes only this session's pages (not the whole Chrome window)
 *   3. Result: each session gets its own tab in ONE Chrome window, sharing cookies/logins/LastPass
 *
 * Root cause of the previous bug:
 *   Context._ensureBrowserContext() calls browserContext.pages() and adopts all existing pages.
 *   Without the proxy, Session 2 would grab Session 1's Google tab and navigate it, destroying
 *   Session 1's work. The session proxy fixes this by making pages() return [] for a new session.
 *
 * Start manually:  node playwright-mcp-server.js
 * Auto-started by: playwright-mcp-visible.js (the stdio bridge)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ── stderr tee ───────────────────────────────────────────────────────────────
// On Windows the bridge starts this server via a Scheduled Task with
// stdio: 'ignore', so everything written to stderr is discarded and the server's
// own decisions are unobservable in production. Diagnosing tab-lifecycle issues from
// tab counts alone cost hours on 2026-08-31; this is what replaced that guesswork.
//
// The filename carries the port so a test instance on another port cannot
// interleave into production's log. Production (3456) keeps plain `server.log`.
const logDir = path.join(__dirname, 'logs');
try {
  fs.mkdirSync(logDir, { recursive: true });
  // Same expression as PORT below (this block runs before PORT is declared, so it
  // cannot reference it). These two MUST stay in sync: if the log name is derived
  // from a different value than the listening port, the log actively lies about
  // which server wrote it, which is worse than having no log at all.
  const logPort = Number(process.env.PLAYWRIGHT_MCP_PORT) || 3456;
  const logFile = path.join(logDir, logPort === 3456 ? 'server.log' : `server-${logPort}.log`);
  // Rotate at ~5MB so an always-on server cannot fill the disk.
  try {
    const st = fs.statSync(logFile);
    if (st.size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1');
  } catch (e) { /* no existing log */ }
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, enc, cb) => {
    try { logStream.write('[' + new Date().toISOString() + '] ' + chunk); } catch (e) { /* never let logging break the server */ }
    return origWrite(chunk, enc, cb);
  };
  process.stderr.write('[playwright-mcp-server] Logging to ' + logFile + '\n');
} catch (e) {
  // Logging is best-effort; a failure here must never prevent startup.
}

// Port, profile and CDP port are env-overridable so a TEST instance can run beside
// the live one. This is test infrastructure, NOT part of any feature: the rollback
// briefly dropped it along with the orphan machinery, which left a server whose log
// filename claimed one port while it bound production's, and whose killStaleChrome
// could only ever match the live profile. A test run then either collides with
// production or kills the user's real Chrome. Defaults are the production values,
// so production behavior is identical.
const PORT = Number(process.env.PLAYWRIGHT_MCP_PORT) || 3456;
const PROFILE_NAME = process.env.PLAYWRIGHT_MCP_PROFILE || 'visible-primary';
const CDP_PORT = Number(process.env.PLAYWRIGHT_MCP_CDP_PORT) || 9223;
const userDataDir = path.join(os.homedir(), '.playwright-profiles', PROFILE_NAME);
fs.mkdirSync(userDataDir, { recursive: true });

// Bare-filename artifacts (screenshots, snapshot dumps) resolve against the SERVER
// PROCESS CWD, not the MCP `outputDir` config — the upstream @playwright/mcp ignores
// outputDir for relative names. When this server is spawned via WMI (see
// playwright-mcp-visible.js) it inherits C:\Windows\System32 as CWD, so a bare
// "foo.png" would hit an EPERM there. Force CWD to the project-root temp/ folder so
// every bare-name artifact lands there. __dirname = Tools/Playwright; root is two up.
const artifactsDir = path.join(__dirname, '..', '..', 'temp');
fs.mkdirSync(artifactsDir, { recursive: true });
process.chdir(artifactsDir);

// ── Download handling (extension repair) ─────────────────────────────────────

// Sites like Stripe's hosted invoice / iPostal1 image exports serve a download
// with an extensionless filename (e.g. a raw object id "2de46b75-...") and a
// Content-Type like application/pdf or image/jpeg. Chrome then saves the raw
// bytes with NO extension, so Windows can't open the file.
//
// There are TWO independent save paths for a download in this setup, and the
// user's Chrome download bar reflects the SECOND one:
//   1. Playwright's per-tab handler (tab.js _downloadStarted) does
//      download.saveAs() into the MCP outputDir (our temp/). It uses
//      download.suggestedFilename() — which for these sites is extensionless.
//   2. Chrome's OWN native downloader also saves the file (this is what appears
//      in Chrome's "download history" popup), using the URL's object-id as the
//      name with no extension.
//
// We fix BOTH:
//   A. patchMcpDownloadNaming() wraps _downloadStarted so the temp/ copy gets a
//      correct extension via magic-byte sniffing (path #1).
//   B. We route Chrome's native downloads (path #2) into a single watched
//      folder (temp/downloads/) via CDP Browser.setDownloadBehavior, and run an
//      fs.watch on that folder that sniffs magic bytes and renames any
//      extensionless file the instant its .crdownload finishes. This governs
//      what actually lands on disk regardless of which path initiated it.

// Chrome's native downloads are routed here and watched for extension repair.
// Using the system Downloads folder so files appear alongside normal Chrome downloads.
// On Windows: C:\Users\<user>\Downloads; on Mac: ~/Downloads
const downloadsDir = path.join(os.homedir(), 'Downloads');
fs.mkdirSync(downloadsDir, { recursive: true });

// Magic-number sniffing for the file types that actually show up here.
// Returns an extension WITHOUT the dot, or '' if unknown.
function sniffExtension(buf) {
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    // ZIP container — also xlsx/docx/pptx, but a bare zip is the safe default.
    return 'zip';
  }
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')) return 'gif';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === '%!PS') return 'ps';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '<?xml') return 'xml';
  return '';
}

// Read the first N bytes of a file into a Buffer.
function readHead(filePath, n = 16) {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(n);
  try {
    const bytesRead = fs.readSync(fd, head, 0, n, 0);
    return head.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// De-dupe a target path by appending " (n)" before the extension.
function uniquePath(dir, base, ext) {
  const suffix = ext ? `.${ext}` : '';
  let candidate = path.join(dir, `${base}${suffix}`);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${suffix}`);
    n += 1;
  }
  return candidate;
}

// Repair a just-saved download file: if it has no extension, sniff the bytes
// and rename it in place. Returns the (possibly new) path. Safe to call on any
// path; leaves already-extensioned or unknown-type files untouched.
function repairSavedDownloadExtension(savedPath) {
  try {
    if (!savedPath || !fs.existsSync(savedPath)) return savedPath;
    const parsed = path.parse(savedPath);
    if (parsed.ext) return savedPath; // already has an extension
    const ext = sniffExtension(readHead(savedPath));
    if (!ext) {
      process.stderr.write(`[playwright-mcp-server] Download extensionless, type unknown: ${savedPath}\n`);
      return savedPath;
    }
    const finalTarget = uniquePath(parsed.dir, parsed.name, ext);
    fs.renameSync(savedPath, finalTarget);
    process.stderr.write(`[playwright-mcp-server] Download extension repaired: ${savedPath} -> ${finalTarget}\n`);
    return finalTarget;
  } catch (e) {
    process.stderr.write(`[playwright-mcp-server] Extension repair error: ${e.message}\n`);
    return savedPath;
  }
}

// Patch @playwright/mcp's Tab.prototype._downloadStarted so that after it saves
// a download, we repair a missing extension. Applied once per process at
// startup against the freshly-required module (survives reinstalls).
function patchMcpDownloadNaming(playwrightDir) {
  try {
    const tabModule = require(path.join(playwrightDir, 'lib/mcp/browser/tab'));
    const Tab = tabModule.Tab;
    if (!Tab || !Tab.prototype || typeof Tab.prototype._downloadStarted !== 'function') {
      process.stderr.write('[playwright-mcp-server] Download patch: Tab._downloadStarted not found — skipping (built-in naming unchanged)\n');
      return;
    }
    if (Tab.prototype._downloadStarted.__extRepairPatched) {
      return; // already patched this process
    }
    const original = Tab.prototype._downloadStarted;
    async function patched(download) {
      // Run the original save. It populates this._downloads[last].outputFile.
      // With Chrome owning downloads via CDP setDownloadBehavior, the artifact
      // may already be gone when this runs (ENOENT) — never let that crash the
      // server; the fs watcher on downloadsDir is the real guarantee.
      try {
        await original.call(this, download);
      } catch (e) {
        process.stderr.write(`[playwright-mcp-server] Built-in _downloadStarted save skipped (${e.message}); watcher will handle it\n`);
        return;
      }
      try {
        const entries = this._downloads;
        const entry = entries && entries[entries.length - 1];
        if (entry && entry.outputFile) {
          const repaired = repairSavedDownloadExtension(entry.outputFile);
          if (repaired !== entry.outputFile) entry.outputFile = repaired;
        }
      } catch (e) {
        process.stderr.write(`[playwright-mcp-server] Download patch post-step error: ${e.message}\n`);
      }
    }
    patched.__extRepairPatched = true;
    Tab.prototype._downloadStarted = patched;
    process.stderr.write('[playwright-mcp-server] Download extension-repair patch applied to Tab._downloadStarted\n');
  } catch (e) {
    process.stderr.write(`[playwright-mcp-server] Download patch failed (non-fatal, built-in naming unchanged): ${e.message}\n`);
  }
}

// Wait until a file's size stops changing (download finished), then resolve.
// Gives up after maxMs. Returns true if the file settled, false on timeout/gone.
function waitForFileStable(filePath, { settleMs = 600, maxMs = 120000 } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    let lastSize = -1;
    let stableSince = 0;
    const tick = () => {
      let st;
      try { st = fs.statSync(filePath); }
      catch { return resolve(false); } // file vanished (e.g. renamed by Chrome)
      if (st.size === lastSize) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= settleMs) return resolve(true);
      } else {
        lastSize = st.size;
        stableSince = 0;
      }
      if (Date.now() - start > maxMs) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

// Watch the downloads folder. When a completed (non-.crdownload) file appears
// with no extension, sniff its magic bytes and rename it to add the right one.
// This is the primary guarantee for Chrome-native downloads.
let _downloadWatcher = null;
function startDownloadsWatcher() {
  if (_downloadWatcher) return;
  const inFlight = new Set(); // filenames currently being processed
  try {
    _downloadWatcher = fs.watch(downloadsDir, async (eventType, filename) => {
      if (!filename) return;
      // Chrome writes to "<name>.crdownload" then renames to "<name>" on finish.
      // Ignore the in-progress temp file; act on the final name.
      if (filename.endsWith('.crdownload')) return;
      if (inFlight.has(filename)) return;

      const full = path.join(downloadsDir, filename);
      // Only care about extensionless files (the bug). Everything else is fine.
      if (path.extname(filename)) return;

      inFlight.add(filename);
      try {
        const settled = await waitForFileStable(full);
        if (!settled || !fs.existsSync(full)) return;
        // Re-check extension in case something already fixed it.
        if (path.extname(full)) return;
        repairSavedDownloadExtension(full);
      } catch (e) {
        process.stderr.write(`[playwright-mcp-server] Watcher error for ${filename}: ${e.message}\n`);
      } finally {
        inFlight.delete(filename);
      }
    });
    process.stderr.write(`[playwright-mcp-server] Watching downloads dir: ${downloadsDir}\n`);
  } catch (e) {
    process.stderr.write(`[playwright-mcp-server] Failed to start downloads watcher (non-fatal): ${e.message}\n`);
  }
}

// Route Chrome's native downloads into the watched downloadsDir via CDP.
// Applies to the whole browser so every tab/session is covered.
async function routeChromeDownloads(context) {
  try {
    // A CDP session on any page reaches Browser.* domain (browser-wide).
    const pages = context.pages();
    const page = pages.length ? pages[0] : await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadsDir,
      eventsEnabled: true,
    });
    process.stderr.write(`[playwright-mcp-server] Chrome native downloads routed to: ${downloadsDir}\n`);
  } catch (e) {
    process.stderr.write(`[playwright-mcp-server] Failed to route Chrome downloads via CDP (non-fatal): ${e.message}\n`);
  }
}

// ── Locate @playwright/mcp installation ──────────────────────────────────────

function findPlaywrightMcpDir() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'mcp'),
    '/opt/homebrew/lib/node_modules/@playwright/mcp',
    '/usr/local/lib/node_modules/@playwright/mcp',
    '/usr/lib/node_modules/@playwright/mcp',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const p = path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@playwright', 'mcp');
    if (fs.existsSync(p)) return p;
  } catch (e) {}
  throw new Error('@playwright/mcp not found. Run: npm install -g @playwright/mcp');
}

// ── Stale Chrome cleanup ──────────────────────────────────────────────────────

async function killStaleChrome(profileDir) {
  // Find and kill any Chrome process using THIS profile (orphaned from a prior run).
  // The pattern comes from profileDir. It was hardcoded to visible-primary, so a
  // server started on any other profile killed the LIVE browser instead of its own.
  // Writes a temp PS1 script to avoid quote-escaping issues in execSync.
  try {
    const psScript = `
$pattern = '*${path.basename(profileDir)}*'
$chromes = Get-Process -Name chrome -ErrorAction SilentlyContinue
foreach ($proc in $chromes) {
  try {
    $wmi = Get-WmiObject Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.CommandLine -like $pattern) {
      Write-Output $proc.Id
    }
  } catch {}
}
`.trim();
    const psFile = path.join(os.tmpdir(), 'pw-kill-chrome.ps1');
    fs.writeFileSync(psFile, psScript, 'utf8');
    const result = execSync(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
    fs.unlinkSync(psFile);
    const pids = result.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    if (pids.length > 0) {
      process.stderr.write(`[playwright-mcp-server] Killing ${pids.length} stale Chrome(s): PIDs ${pids.join(', ')}\n`);
      execSync(`taskkill /F ${pids.map(p => `/PID ${p}`).join(' ')}`, { stdio: 'ignore', timeout: 5000, windowsHide: true });
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) {
    // Non-fatal — launchPersistentContext has its own retry logic for exitCode=21
    process.stderr.write(`[playwright-mcp-server] Stale Chrome check failed (non-fatal): ${e.message}\n`);
  }
}

// ── Per-session browser context factory ──────────────────────────────────────

/**
 * Creates a factory that, for each SSE session, returns a proxy of the shared
 * BrowserContext scoped to that session. Each session gets its own pages (tabs)
 * and cannot see or interfere with other sessions' tabs.
 *
 * Why the proxy is needed:
 *   Playwright MCP's Context class calls browserContext.pages() on init and adopts
 *   all existing pages. Without isolation, Session 2 would steal Session 1's tab.
 *   The proxy makes pages() return [] for new sessions, forcing each Context to
 *   create its own fresh page via newPage().
 */
/**
 * Wraps a Playwright Page so that screenshot() calls bringToFront() first.
 * This ensures the correct tab is focused when multiple sessions share one
 * Chrome window — otherwise screenshot() captures whichever tab is active.
 */
function wrapPageWithBringToFront(page) {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === 'screenshot') {
        return async (...args) => {
          await target.bringToFront();
          return target.screenshot(...args);
        };
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

function createSessionContextFactory(getSharedContext) {
  return {
    createContext: async () => {
      const sharedContext = await getSharedContext();
      // Map of original page → wrapped page (with bringToFront on screenshot).
      // Using a Map so cleanup can iterate originals while MCP sees wrapped pages.
      const ownPages = new Map();

      // Track when THIS session is in the middle of creating a new page.
      // Used to filter the shared context's 'page' event so each session only
      // receives page events for pages it created (not pages from other sessions).
      let creatingPage = false;

      // Keep references to wrapped 'page' listeners so we can remove them on close,
      // preventing listener accumulation across closeBrowserContext()/re-init cycles.
      const registeredPageListeners = [];

      const sessionCtx = new Proxy(sharedContext, {
        get(target, prop) {
          // Return only this session's pages — prevents Context from adopting
          // pre-existing pages that belong to other sessions.
          if (prop === 'pages') {
            return () => [...ownPages.values()];
          }

          // Intercept newPage to track ownership and wrap with bringToFront.
          // creatingPage=true during creation so the 'page' event handler below
          // knows to forward the event to this session's listener.
          if (prop === 'newPage') {
            return async (...args) => {
              creatingPage = true;
              try {
                const page = await target.newPage(...args);
                const wrapped = wrapPageWithBringToFront(page);
                ownPages.set(page, wrapped);
                page.on('close', () => ownPages.delete(page));
                return wrapped;
              } finally {
                creatingPage = false;
              }
            };
          }

          // Intercept 'page' event subscriptions so sessions don't see each
          // other's page creation events. Two cases must be forwarded:
          //   1. creatingPage=true — this session called newPage() itself.
          //   2. page.opener() is one of THIS session's pages — the page was
          //      opened by our own tab via window.open() / target="_blank"
          //      (vendor "Manage Billing" buttons, OAuth popups, invoice links).
          // Case 2 used to be dropped, which is why popup tabs went invisible:
          // never tracked in ownPages, so pages() and browser_tabs never saw
          // them and snapshots came back blank. Popups from OTHER sessions have
          // an opener outside ownPages, so isolation still holds.
          if (prop === 'on') {
            return (event, handler) => {
              if (event === 'page') {
                const wrapped = async page => {
                  if (creatingPage) {
                    handler(page);
                    return;
                  }
                  let opener = null;
                  try {
                    opener = await page.opener();
                  } catch (e) {
                    // Page may have closed before we could inspect it; ignore.
                  }
                  if (!opener || !ownPages.has(opener)) return;
                  const alreadyTracked = ownPages.has(page);
                  const adopted = alreadyTracked ? ownPages.get(page) : wrapPageWithBringToFront(page);
                  if (!alreadyTracked) {
                    ownPages.set(page, adopted);
                    page.on('close', () => ownPages.delete(page));
                    process.stderr.write('[playwright-mcp-server] Adopted popup tab opened by this session\n');
                  }
                  handler(adopted);
                };
                registeredPageListeners.push(wrapped);
                target.on('page', wrapped);
              } else {
                target.on(event, handler);
              }
            };
          }

          // Block close() and closeBrowserContext() — they would close the shared Chrome window.
          // Sessions should only close their own pages, not the entire context.
          if (prop === 'close' || prop === 'closeBrowserContext') {
            process.stderr.write(`[playwright-mcp-server] Session attempted to close shared context via ${prop}() — blocking\n`);
            return async () => {
              // No-op: silently ignore attempts to close the shared context
            };
          }

          const val = target[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        }
      });

      return {
        browserContext: sessionCtx,
        // On session end: close only this session's pages, not the shared Chrome window.
        // Also remove all registered 'page' listeners to prevent accumulation when
        // closeBrowserContext() is called on last-tab-close and context is re-initialized.
        close: async () => {
          try {
            // Close THIS session's pages immediately. This is the original behavior,
            // restored on 2026-08-31 after three days of timer-based machinery failed
            // to reproduce it: an event beats a timer, and the two
            // causes that made this destructive (the LazyHub idle reaper killing the
            // bridge, and the bridge self-exiting on SSE drop) were both fixed
            // separately and are still fixed.
            if (ownPages.size > 0) {
              process.stderr.write(
                `[playwright-mcp-server] Session ended — closing ${ownPages.size} page(s)\n`
              );
            }
            for (const page of [...ownPages.keys()]) {
              try {
                await page.close();
              } catch (e) {
                // Page may already be closed; ignore
              }
            }
            for (const wrapped of registeredPageListeners) {
              try {
                sharedContext.removeListener('page', wrapped);
              } catch (e) {
                // Listener may not exist; ignore
              }
            }
            registeredPageListeners.length = 0;
          } catch (e) {
            process.stderr.write(`[playwright-mcp-server] Error during session close: ${e.message}\n`);
          }
        }
      };
    }
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mcpDir = findPlaywrightMcpDir();
  const playwrightDir = path.join(mcpDir, 'node_modules', 'playwright');

  // Load internals from @playwright/mcp's bundled playwright
  const playwright = require(playwrightDir);
  const { BrowserServerBackend } = require(path.join(playwrightDir, 'lib/mcp/browser/browserServerBackend'));
  const { resolveConfig } = require(path.join(playwrightDir, 'lib/mcp/browser/config'));
  const { startMcpHttpServer } = require(path.join(playwrightDir, 'lib/mcp/sdk/http'));
  const packageJSON = require(path.join(playwrightDir, 'package.json'));

  // Patch the built-in download naming so extensionless downloads (e.g. Stripe
  // hosted-invoice PDFs) are saved with a correct extension. Non-fatal if it fails.
  patchMcpDownloadNaming(playwrightDir);

  process.stderr.write(`[playwright-mcp-server] Starting on port ${PORT}\n`);
  process.stderr.write(`[playwright-mcp-server] Profile: ${userDataDir}\n`);

  // Build MCP config (used for tool filtering, timeouts, output dirs, etc.)
  const config = await resolveConfig({
    browser: {
      browserName: 'chromium',
      launchOptions: { channel: 'chrome' },
      userDataDir,
    },
    // Screenshots/exports land in the PROJECT-ROOT temp/ folder (the workspace's
    // disposable-artifacts dir), not under Tools/Playwright/.playwright-mcp.
    // A bare filename like "foo.png" now resolves to <project-root>/temp/foo.png,
    // honoring the "never write artifacts to the project root" rule by default.
    // __dirname = Tools/Playwright, so project root is two levels up.
    outputDir: path.join(__dirname, '..', '..', 'temp'),
    allowUnrestrictedFileAccess: true,
  });

  // Lazy Chrome launch — opens only on the first real tool call, not on MCP handshake.
  // This prevents Chrome from popping up every time a Claude Code session starts.
  let sharedContext = null;
  let chromeLaunching = null;

  async function getSharedContext() {
    if (sharedContext) return sharedContext;
    // Deduplicate concurrent callers — only one launch in flight at a time
    if (!chromeLaunching) {
      chromeLaunching = (async () => {
        await killStaleChrome(userDataDir);
        process.stderr.write('[playwright-mcp-server] Launching Chrome (first tool use)...\n');
        sharedContext = await playwright.chromium.launchPersistentContext(userDataDir, {
          channel: 'chrome',
          headless: false,
          handleSIGINT: false,
          handleSIGTERM: false,
          // Chrome owns downloads (routed via CDP Browser.setDownloadBehavior to
          // downloadsDir, then renamed by the fs watcher). Do NOT let Playwright
          // also intercept downloads — acceptDownloads:true makes _downloadStarted
          // race Chrome for the same artifact and crash with ENOENT.
          acceptDownloads: false,
          ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
          args: ['--disable-blink-features=AutomationControlled', `--remote-debugging-port=${CDP_PORT}`],
          viewport: null,
        });
        process.stderr.write('[playwright-mcp-server] Chrome launched\n');
        // Route Chrome's native downloads into the watched folder + start the
        // extension-repair watcher. Both are best-effort (non-fatal on failure).
        startDownloadsWatcher();
        await routeChromeDownloads(sharedContext);
        sharedContext.on('close', () => {
          process.stderr.write('[playwright-mcp-server] Chrome closed — will relaunch on next tool call\n');
          sharedContext = null;
          chromeLaunching = null;
        });
        chromeLaunching = null;
      })();
    }
    await chromeLaunching;
    return sharedContext;
  }

  // Per-SSE-connection factory: each create() call returns a new session-scoped
  // proxy of the shared BrowserContext. Each session gets its own tab(s).
  const sessionFactory = createSessionContextFactory(getSharedContext);

  const serverBackendFactory = {
    name: 'Playwright',
    version: packageJSON.version,
    nameInConfig: 'playwright',
    create: () => new BrowserServerBackend(config, sessionFactory),
  };

  // Start the HTTP/SSE server — playwright-mcp-visible.js bridges stdio ↔ /sse
  const url = await startMcpHttpServer({ port: PORT }, serverBackendFactory, ['*']);
  process.stderr.write(`[playwright-mcp-server] Ready — listening on ${url}\n`);
  process.stderr.write(`[playwright-mcp-server] SSE endpoint: ${url}/sse\n`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    process.stderr.write('[playwright-mcp-server] Shutting down...\n');
    if (sharedContext) await sharedContext.close().catch(() => {});
    process.exit(0);
  });
}

// Safety net: a stray rejection from Playwright internals (e.g. a download
// artifact race) must never take down the shared server that every Claude Code
// session depends on. Log and keep running.
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  process.stderr.write(`[playwright-mcp-server] Unhandled rejection (ignored, server stays up): ${msg}\n`);
});

main().catch(e => {
  process.stderr.write('[playwright-mcp-server] Fatal: ' + e.message + '\n');
  process.stderr.write(e.stack + '\n');
  process.exit(1);
});
