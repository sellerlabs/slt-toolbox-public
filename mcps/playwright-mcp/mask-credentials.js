/**
 * mask-credentials.js
 *
 * Shared credential masking for BOTH Playwright MCP bridges (visible + headless).
 *
 * WHY THIS EXISTS: a LastPass/browser-prefilled password field can appear in an
 * ARIA snapshot with its literal plaintext value, e.g.
 *   - textbox "Password field" [ref=e35]: hunter2
 * which then lands in the session transcript and syncs to OneDrive. This happened
 * live on app.bluevine.com/login on 2026-08-04.
 *
 * Detection is FIELD-SHAPE based, not value based: it does not need to know what
 * the password is, only that the node is a value-carrying control with a
 * credential-ish label. That is what catches a password nobody enumerated in
 * advance, which is exactly how the Bluevine leak happened.
 *
 * Masking must be unconditional and size-independent. Do NOT move it into the
 * visible bridge's snapshot compressor: that path is opt-out (COMPRESS_SNAPSHOTS
 * !== '0') and only fires on text over 10000 chars, so a control there silently
 * no-ops on a small login page, which is precisely the page that leaked.
 */

const MASK = '[MASKED]';

// Roles that can carry a typed value in an ARIA snapshot.
const VALUE_ROLES = 'textbox|searchbox|combobox|spinbutton|slider|textarea';

// Label patterns that indicate a credential field. Label matching is the only
// available signal: the ARIA tree does not expose input[type=password].
const SENSITIVE_LABEL = /pass\s*word|passcode|passphrase|\bpin\b|\botp\b|one[-\s]?time|verification\s*code|security\s*code|auth(entication)?\s*code|2fa|mfa|api[-\s]?key|secret|token|ssn|social\s*security|account\s*number|routing\s*number|card\s*number|\bcvv\b|\bcvc\b/i;

/**
 * Replace the value tail of any credential ARIA node with [MASKED].
 * Non-credential fields keep their values, so ordinary snapshots stay useful.
 *
 * Two detection paths, both FIELD-SHAPE based, never value based:
 *
 *  1. LABELED - the node carries a quoted accessible name that reads as a
 *     credential, e.g. `textbox "Password field" [ref=e35]: hunter2`.
 *
 *  2. UNLABELED - the node has no accessible name at all, e.g.
 *     `textbox [ref=e52]: Wa%bs6N#`, which is how DocHub rendered its password
 *     input on 2026-08-21, and how a real password reached the transcript.
 *     Here the accessible name is gone, so the only signal left is the
 *     surrounding tree. A value is masked ONLY when credential intent appears
 *     in the node's enclosing context: an ancestor line (strictly shallower
 *     indent) or one of the few immediately preceding siblings.
 *
 *     Masking every unlabeled value instead would blank ordinary form fields
 *     and make snapshots useless, which is the failure mode the original
 *     label-only design was deliberately avoiding. Value-shape guessing
 *     (entropy, symbol mix) is also rejected on purpose: it masks order IDs
 *     and SKUs while sailing straight past `password123`.
 */

// How many immediately preceding siblings may supply credential context to an
// unlabeled field. A login form puts its "Password" caption right before the
// input; a wide window starts borrowing intent from unrelated page sections.
const CONTEXT_WINDOW = 3;

// A line that is itself a value-carrying control (labeled or not).
const VALUE_ROLE_LINE = new RegExp('^\\s*-?\\s*(?:' + VALUE_ROLES + ')\\b', 'i');

// An ARIA node line, split into indent / role / optional quoted label / tail.
// The label group is optional, which is what lets an unlabeled node match.
const NODE_LINE = new RegExp(
  '^(\\s*)-?\\s*(?:' + VALUE_ROLES + ')(?:\\s+"([^"]*)")?[^\\n:]*:\\s*(.+)$',
  'i'
);

function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * Does the surrounding tree mark the node at `lines[i]` as a credential field?
 * Walks upward: ancestors are lines at strictly shallower indent, siblings are
 * lines at the same indent. Subtrees of earlier siblings are skipped, since a
 * sibling's children are not this node's context.
 */
function hasCredentialContext(lines, i, indent) {
  let siblingsSeen = 0;
  let deepestAllowed = indent;

  for (let j = i - 1; j >= 0; j--) {
    const line = lines[j];
    if (!line.trim()) continue;

    const ind = indentOf(line);
    if (ind > deepestAllowed) continue; // inside an earlier sibling's subtree

    if (ind === indent) {
      // A credential caption binds to the ONE field that follows it. Another
      // value-carrying control between us and that caption means the caption
      // was describing that field, not this one, so the search ends here.
      // Without this, a login form leaks intent forward and the "Search"
      // box next to a password box gets masked too (seen live 2026-08-21).
      if (VALUE_ROLE_LINE.test(line)) return false;
      if (++siblingsSeen > CONTEXT_WINDOW) return false;
      if (SENSITIVE_LABEL.test(line)) return true;
      continue;
    }

    // Shallower: an ancestor (group, form, dialog, heading).
    if (SENSITIVE_LABEL.test(line)) return true;
    deepestAllowed = ind; // climb, never re-enter a deeper branch
  }

  return false;
}

// Secrets shorter than this are not scrubbed from the rest of the text: a 2-3
// char value would blank common substrings everywhere. The field line itself is
// still masked regardless of length.
const MIN_ECHO_LEN = 4;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pass 2: remove every remaining echo of each detected secret. Chromium names a
 * row/cell from its descendant text INCLUDING input values, so a layout-table
 * login page repeats the password in every ancestor name (Fulton County water
 * portal, 2026-10-19). Detection stays field-shape based; the value is used only
 * to scrub its own copies. The escaped forms cover names Playwright quotes with
 * backslash escapes (secret contains `"` or `\`) and the YAML single-quoted
 * wrapper it puts around row/cell lines containing a colon (`'` doubled).
 */
function scrubEchoes(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_ECHO_LEN) continue;
    const escaped = JSON.stringify(secret).slice(1, -1);
    const forms = [secret, escaped];
    const variants = new Set([...forms, ...forms.map(f => f.replace(/'/g, "''"))]);
    for (const v of variants) {
      out = out.replace(new RegExp(escapeRegExp(v), 'g'), MASK);
    }
  }
  return out;
}

function maskCredentials(text) {
  if (!text || typeof text !== 'string') return text;
  if (!new RegExp(VALUE_ROLES, 'i').test(text)) return text;

  const lines = text.split('\n');
  const secrets = new Set();
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(NODE_LINE);
    if (!m) continue;

    const indent = m[1];
    const label = m[2];
    const value = m[3];
    if (value.trim() === MASK) continue;

    const isCredential = label !== undefined
      ? SENSITIVE_LABEL.test(label)
      : hasCredentialContext(lines, i, indent.length);
    if (!isCredential) continue;

    // Replace only the value tail, so structure and [ref=] survive.
    const head = lines[i].slice(0, lines[i].lastIndexOf(value)).replace(/:\s*$/, '');
    lines[i] = head + ': ' + MASK;
    secrets.add(value.trim());
    changed = true;
  }

  return changed ? scrubEchoes(lines.join('\n'), secrets) : text;
}

/**
 * Mask credential values inside a JSON-RPC message string.
 * Returns the (possibly rewritten) string; input is returned untouched if it is
 * not parseable JSON or carries no maskable content, so non-JSON stdout traffic
 * passes through safely.
 */
function maskJsonRpcLine(line) {
  if (!line || typeof line !== 'string') return line;
  // Cheap pre-filter: skip the JSON parse entirely unless a value role appears.
  if (!/textbox|searchbox|combobox|spinbutton|slider|textarea/i.test(line)) return line;
  try {
    const msg = JSON.parse(line);
    const items = msg?.result?.content;
    if (!Array.isArray(items)) return line;
    let masked = false;
    for (const item of items) {
      if (item.type === 'text' && item.text) {
        const out = maskCredentials(item.text);
        if (out !== item.text) { item.text = out; masked = true; }
      }
    }
    return masked ? JSON.stringify(msg) : line;
  } catch (e) {
    return line;
  }
}

/**
 * Boot self-test. The headless bridge masks by patching process.stdout.write,
 * an in-process seam upstream does not guarantee, so verify at startup that the
 * mask still behaves rather than discovering a silent bypass during an incident.
 *
 * Four probes, because the mask has four ways to fail and each is a separate
 * incident:
 *   labeled   - the original 2026-08-04 Bluevine case.
 *   unlabeled - the 2026-08-21 DocHub case: no accessible name, credential
 *               intent only in the surrounding tree.
 *   utility   - the guard against "fix" it by masking everything, which would
 *               make snapshots useless rather than safe.
 *   ancestor  - the 2026-10-19 Fulton County case: the field line was masked
 *               but row/cell names above it echoed the plaintext.
 * Returns true on pass; writes to stderr and returns false on failure.
 */
function selfTest(label) {
  const labeled = maskCredentials(
    '- textbox "Password field" [ref=e1]: correct-horse-battery\n' +
    '- textbox "Search" [ref=e2]: blue widgets'
  );
  const labeledOk = labeled.includes('"Password field" [ref=e1]: ' + MASK) &&
                    !labeled.includes('correct-horse-battery') &&
                    labeled.includes('blue widgets');

  const unlabeled = maskCredentials(
    '- form [ref=e3]:\n' +
    '  - text: Password\n' +
    '  - textbox [ref=e4]: unlabeled-secret-value'
  );
  const unlabeledOk = !unlabeled.includes('unlabeled-secret-value') &&
                      unlabeled.includes('[ref=e4]: ' + MASK);

  // Shaped like the tree Playwright actually emits: captions are `generic`
  // nodes at the SAME indent as the inputs. The search box sits right after a
  // password box, which is where over-masking showed up live on 2026-08-21.
  const utility = maskCredentials(
    '- generic [ref=e5]:\n' +
    '  - generic [ref=e6]: Password\n' +
    '  - textbox [ref=e7]: probe-secret\n' +
    '  - generic [ref=e8]: Search products\n' +
    '  - textbox [ref=e9]: blue widgets\n' +
    '  - spinbutton [ref=e10]: 42'
  );
  const utilityOk = !utility.includes('probe-secret') &&
                    utility.includes('blue widgets') &&
                    utility.includes('42');

  // The 2026-10-19 Fulton County water portal case: a DotNetNuke layout-table
  // login page. Chromium names each row/cell from its descendant text INCLUDING
  // input values, so the field line was masked but its ancestors still carried
  // the plaintext. Every echo of a detected secret must go, not just the tail.
  const ancestor = maskCredentials(
    '- table [ref=e11]:\n' +
    '  - row "Account Login Username: probe-user Password: probe-ancestor-secret Login" [ref=e12]:\n' +
    '    - cell "Username: probe-user Password: probe-ancestor-secret" [ref=e13]:\n' +
    '      - textbox "Username:" [ref=e14]: probe-user\n' +
    '      - textbox "Password:" [ref=e15]: probe-ancestor-secret'
  );
  const ancestorOk = !ancestor.includes('probe-ancestor-secret') &&
                     ancestor.includes('"Password:" [ref=e15]: ' + MASK) &&
                     ancestor.includes('probe-user');

  const ok = labeledOk && unlabeledOk && utilityOk && ancestorOk;
  if (!ok) {
    const failed = [
      labeledOk   ? null : 'labeled',
      unlabeledOk ? null : 'unlabeled',
      utilityOk   ? null : 'utility(over-masking)',
      ancestorOk  ? null : 'ancestor(name echo)'
    ].filter(Boolean).join(', ');
    process.stderr.write(
      `[${label}] *** CREDENTIAL MASK SELF-TEST FAILED [${failed}] *** ` +
      `snapshots may leak passwords, or may be over-masked into uselessness. ` +
      `Check mask-credentials.js against the current @playwright/mcp output format.\n`
    );
  }
  return ok;
}

module.exports = { MASK, maskCredentials, maskJsonRpcLine, selfTest };
