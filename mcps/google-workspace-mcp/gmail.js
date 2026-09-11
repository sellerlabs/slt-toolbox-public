/**
 * gmail.js — Gmail API tool implementations
 */

// Scoped client instead of the `googleapis` meta-package (changed 2026-08-11).
// The meta-package builds ~350 API surfaces at import time: 115MB on disk and
// ~1,009ms per process, versus 16MB and ~310ms for the five scoped clients this
// server actually uses. That mattered because cold-start file reads run ~360x
// slower than warm (per-file AV scan), so this child was timing out at 18s during
// hub discovery and taking the Gmail tools down with it. Shaped as a `google`
// object so the ~33 existing call sites stay untouched.
import { gmail as gmailApi } from '@googleapis/gmail'
const google = { gmail: gmailApi }

/**
 * Repair mojibake in inbound header text (added 2026-09-10).
 *
 * Some mail clients encode a UTF-8 subject, misread those bytes as Windows-1252,
 * then re-encode the result as UTF-8 and label the header `=?UTF-8?Q?`. An em dash
 * (E2 80 94) arrives as "\u00e2\u20ac\u201d". Gmail decodes it correctly per the DECLARED
 * charset, so the corruption is already baked in before we see it -- it is a
 * sender-side bug we can only repair cosmetically.
 *
 * Display layer only: callers use this for the value they show, never for what they
 * store, reply to, or match on. Deliberately conservative -- a subject that genuinely
 * contains that character sequence must survive untouched, so a repair is applied
 * ONLY when both hold:
 *   1. the text carries a known mojibake signature, and
 *   2. the Windows-1252 round-trip is lossless (every char is a single byte, and the
 *      re-decode as UTF-8 yields no U+FFFD).
 * If either fails, the original string is returned unchanged.
 */
// The 27 Windows-1252 code points in 0x80-0x9F that differ from latin1. Mojibake from
// a cp1252 misread routes through these, so a plain latin1 round-trip is not enough --
// notably U+20AC (euro), which latin1 cannot represent at all.
const CP1252_HIGH = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
])

/** Encode to Windows-1252 bytes, or null if any char is not representable. */
function toCp1252(text) {
  const out = Buffer.alloc(text.length)
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)
    if (cp > 0xffff) return null
    if (cp <= 0xff) {
      // 0x80-0x9F are undefined in cp1252; a raw C1 control means this is not mojibake.
      if (cp >= 0x80 && cp <= 0x9f) return null
      out[i] = cp
    } else {
      const b = CP1252_HIGH.get(cp)
      if (b === undefined) return null
      out[i] = b
    }
  }
  return out
}

const MOJIBAKE_SIGNATURE = /\u00e2\u20ac|\u00c3[\u00a0-\u00bf]|\u00c2[\u00a0-\u00bf]/

function repairMojibake(text) {
  if (typeof text !== 'string' || !text) return text
  if (!MOJIBAKE_SIGNATURE.test(text)) return text

  // Every char must be representable in Windows-1252, or this is not double-encoded
  // text and reinterpreting it would destroy data.
  const bytes = toCp1252(text)
  if (bytes === null) return text

  const decoded = bytes.toString('utf8')
  // U+FFFD means those bytes were not valid UTF-8 -- the premise was wrong, back off.
  if (decoded.includes('\uFFFD') || decoded === text) return text

  console.error(`[gmail] repaired mojibake header: ${JSON.stringify(text)} -> ${JSON.stringify(decoded)}`)
  return decoded
}


/**
 * Search Gmail messages for an account.
 * Returns a list of message summaries.
 */
export async function searchGmail(auth, query, maxResults = 20) {
  const gmail = google.gmail({ version: 'v1', auth })
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  })

  const messages = listRes.data.messages || []
  if (messages.length === 0) return []

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      })
    )
  )

  return details.map(({ data }) => {
    const headers = Object.fromEntries(
      (data.payload?.headers || []).map((h) => [h.name, h.value])
    )
    return {
      id: data.id,
      threadId: data.threadId,
      subject: repairMojibake(headers['Subject']) || '(no subject)',
      from: repairMojibake(headers['From']) || '',
      date: headers['Date'] || '',
      snippet: repairMojibake(data.snippet) || '',
      labelIds: data.labelIds || [],
    }
  })
}

/**
 * List messages in a Gmail label (default: INBOX).
 */
export async function listGmail(auth, label = 'INBOX', maxResults = 20) {
  return searchGmail(auth, `label:${label}`, maxResults)
}

/**
 * Read a full Gmail message by ID, returning subject, from, date, and body text.
 */
export async function readGmail(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  })

  const headers = Object.fromEntries(
    (data.payload?.headers || []).map((h) => [h.name, h.value])
  )

  const body = extractBody(data.payload)
  const attachments = extractAttachments(data.payload)

  return {
    id: data.id,
    threadId: data.threadId,
    subject: repairMojibake(headers['Subject']) || '(no subject)',
    from: repairMojibake(headers['From']) || '',
    to: headers['To'] || '',
    date: headers['Date'] || '',
    body,
    attachments,
    labelIds: data.labelIds || [],
  }
}

/**
 * List all Gmail labels for an account.
 */
export async function listGmailLabels(auth) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.labels.list({ userId: 'me' })
  return (data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }))
}

/**
 * Get an existing label by name, or create it if it doesn't exist.
 * Returns the label ID.
 */
export async function getOrCreateLabel(auth, name) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.labels.list({ userId: 'me' })
  const existing = (data.labels || []).find((l) => l.name === name)
  if (existing) return existing.id

  const { data: created } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  })
  return created.id
}

/**
 * Rename an existing Gmail label.
 */
export async function renameGmailLabel(auth, labelId, newName) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.labels.update({
    userId: 'me',
    id: labelId,
    requestBody: { name: newName },
  })
  return { id: data.id, name: data.name }
}

/**
 * Modify labels on a Gmail message.
 * Use addLabelIds to apply labels (e.g. a custom label ID).
 * Use removeLabelIds to remove labels (e.g. 'UNREAD', 'INBOX').
 */
export async function modifyGmailMessage(auth, messageId, addLabelIds = [], removeLabelIds = []) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds, removeLabelIds },
  })
  return { id: data.id, labelIds: data.labelIds }
}

/**
 * Modify labels on an entire Gmail thread (marks all messages in the thread at once).
 * More reliable than modifyGmailMessage for marking threads as read.
 */
export async function modifyGmailThread(auth, threadId, addLabelIds = [], removeLabelIds = []) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { addLabelIds, removeLabelIds },
  })
  return { id: data.id, messages: (data.messages || []).map((m) => ({ id: m.id, labelIds: m.labelIds })) }
}

/**
 * Build a MIME type string from a file extension.
 */
function mimeTypeFromPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase()
  const map = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    zip: 'application/zip',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
  }
  return map[ext] || 'application/octet-stream'
}

/**
 * RFC 2047 encode a MIME header value that contains non-ASCII characters.
 *
 * MIME headers have no charset mechanism, so a raw UTF-8 em dash in `Subject:`
 * is read by Gmail as Latin-1 and arrives mojibake'd. Bodies are unaffected
 * because their parts declare `charset=utf-8`.
 *
 * Pure-ASCII values are returned unchanged, so the common case is byte-identical
 * to the previous behavior. Longer values are split across multiple encoded-words
 * to respect the 75-char per-line cap; the 45-byte chunk keeps each base64 word
 * under 63 chars. Chunking walks code points, never bytes, so a multi-byte
 * character is not split down the middle.
 */
function encodeMimeHeader(value) {
  if (!value || !/[^\x00-\x7F]/.test(value)) return value
  const words = []
  let chunk = ''
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    chunk = ''
  }
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) flush()
    chunk += ch
  }
  flush()
  return words.join('\r\n ')
}

/**
 * Build a multipart/alternative block (plain text + HTML).
 * Returns { boundary, block } where block is the MIME string.
 */
function buildAlternativePart(plainText, htmlBody) {
  const boundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const block = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    plainText,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
    `--${boundary}--`,
  ].join('\r\n')
  return { boundary, block }
}

function autoLinkUrls(text) {
  return text.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1">$1</a>')
}

/**
 * Strip HTML tags to produce a plain text fallback.
 */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * Guard against HTML-escaped bodyHtml.
 * A caller that passes '&lt;p&gt;Hi&lt;/p&gt;' produces a message whose text/html
 * part shows literal tags in Gmail. The unambiguous signature is: contains
 * escaped tag entities AND contains no real tags at all. A body that merely
 * mentions &lt; alongside real markup is legitimate and left untouched.
 */
function unescapeIfFullyEscapedHtml(bodyHtml, context) {
  if (!bodyHtml) return bodyHtml
  const hasEscapedTags = /&lt;\/?[a-z]/i.test(bodyHtml)
  const hasRealTags = /<[a-z][\s\S]*>/i.test(bodyHtml)
  if (!hasEscapedTags || hasRealTags) return bodyHtml
  console.error(`[gmail] ${context}: bodyHtml was HTML-escaped (escaped tag entities, no real tags); auto-corrected before sending.`)
  return bodyHtml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Create a Gmail draft, optionally with file attachments and HTML body.
 * attachmentPaths: array of absolute local file paths to attach.
 * bodyHtml: optional HTML version of the body (enables rich formatting and hyperlinks).
 * cc: optional CC email address(es), comma-separated string.
 */
export async function createGmailDraft(auth, to, subject, body, attachmentPaths = [], threadId = null, replyToMessageId = null, bodyHtml = null, cc = null) {
  const gmail = google.gmail({ version: 'v1', auth })

  const replyHeaders = replyToMessageId
    ? [`In-Reply-To: ${replyToMessageId}`, `References: ${replyToMessageId}`]
    : []

  const ccHeader = cc ? [`CC: ${cc}`] : []

  // Auto-link URLs and auto-detect HTML in body when bodyHtml was not provided
  if (!bodyHtml && body) {
    const linked = autoLinkUrls(body)
    if (linked !== body || /<(html|body|p|ul|ol|div|table|br|h[1-6]|strong|em|a\s)[\s>]/i.test(body)) {
      bodyHtml = linked.replace(/\n/g, '<br>\n')
      body = stripHtml(bodyHtml)
    }
  }

  bodyHtml = unescapeIfFullyEscapedHtml(bodyHtml, 'createGmailDraft')

  let raw

  const hasHtml = !!bodyHtml
  const hasAttachments = attachmentPaths.length > 0

  if (!hasHtml && !hasAttachments) {
    // Simple plain text message
    const message = [
      `To: ${to}`,
      ...ccHeader,
      `Subject: ${encodeMimeHeader(subject)}`,
      ...replyHeaders,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n')
    raw = Buffer.from(message).toString('base64url')
  } else if (hasHtml && !hasAttachments) {
    // HTML + plain text alternative, no attachments
    const plainText = body || stripHtml(bodyHtml)
    const { boundary, block } = buildAlternativePart(plainText, bodyHtml)
    const message = [
      `To: ${to}`,
      ...ccHeader,
      `Subject: ${encodeMimeHeader(subject)}`,
      ...replyHeaders,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      block,
    ].join('\r\n')
    raw = Buffer.from(message).toString('base64url')
  } else {
    // multipart/mixed — with attachments (and optionally HTML)
    const { readFile } = await import('fs/promises')
    const { basename } = await import('path')

    const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const parts = []

    if (hasHtml) {
      const plainText = body || stripHtml(bodyHtml)
      const { boundary: altBoundary, block: altBlock } = buildAlternativePart(plainText, bodyHtml)
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        '',
        altBlock,
      )
    } else {
      parts.push(
        `--${mixedBoundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
      )
    }

    for (const filePath of attachmentPaths) {
      const fileData = await readFile(filePath)
      const filename = basename(filePath)
      const mimeType = mimeTypeFromPath(filePath)
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: ${mimeType}; name="${filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${filename}"`,
        '',
        fileData.toString('base64'),
      )
    }

    parts.push(`--${mixedBoundary}--`)

    const message = [
      `To: ${to}`,
      ...ccHeader,
      `Subject: ${encodeMimeHeader(subject)}`,
      ...replyHeaders,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      parts.join('\r\n'),
    ].join('\r\n')

    raw = Buffer.from(message).toString('base64url')
  }

  const requestBody = { message: { raw } }
  if (threadId) requestBody.message.threadId = threadId

  const { data } = await gmail.users.drafts.create({
    userId: 'me',
    requestBody,
  })

  return { draftId: data.id, message: data.message }
}

/**
 * Send an existing Gmail draft by draft ID.
 * Returns the sent message metadata.
 */
export async function sendGmailDraft(auth, draftId) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.drafts.send({
    userId: 'me',
    requestBody: { id: draftId },
  })
  return { sent: true, messageId: data.id, threadId: data.threadId, labelIds: data.labelIds }
}

/**
 * Compose and send a Gmail message immediately (no draft saved).
 * Same signature as createGmailDraft but calls messages.send instead.
 */
export async function sendGmailMessage(auth, to, subject, body, attachmentPaths = [], threadId = null, replyToMessageId = null, bodyHtml = null, cc = null) {
  const gmail = google.gmail({ version: 'v1', auth })

  const replyHeaders = replyToMessageId
    ? [`In-Reply-To: ${replyToMessageId}`, `References: ${replyToMessageId}`]
    : []

  const ccHeader = cc ? [`CC: ${cc}`] : []

  // Auto-link URLs and auto-detect HTML in body when bodyHtml was not provided
  if (!bodyHtml && body) {
    const linked = autoLinkUrls(body)
    if (linked !== body || /<(html|body|p|ul|ol|div|table|br|h[1-6]|strong|em|a\s)[\s>]/i.test(body)) {
      bodyHtml = linked.replace(/\n/g, '<br>\n')
      body = stripHtml(bodyHtml)
    }
  }

  bodyHtml = unescapeIfFullyEscapedHtml(bodyHtml, 'sendGmailMessage')

  let raw

  const hasHtml = !!bodyHtml
  const hasAttachments = attachmentPaths.length > 0

  if (!hasHtml && !hasAttachments) {
    const message = [
      `To: ${to}`,
      ...ccHeader,
      `Subject: ${encodeMimeHeader(subject)}`,
      ...replyHeaders,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n')
    raw = Buffer.from(message).toString('base64url')
  } else if (hasHtml && !hasAttachments) {
    const plainText = body || stripHtml(bodyHtml)
    const { boundary, block } = buildAlternativePart(plainText, bodyHtml)
    const message = [
      `To: ${to}`,
      ...ccHeader,
      `Subject: ${encodeMimeHeader(subject)}`,
      ...replyHeaders,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      block,
    ].join('\r\n')
    raw = Buffer.from(message).toString('base64url')
  } else {
    const { readFile } = await import('fs/promises')
    const { basename } = await import('path')

    const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const parts = []

    if (hasHtml) {
      const plainText = body || stripHtml(bodyHtml)
      const { boundary: altBoundary, block: altBlock } = buildAlternativePart(plainText, bodyHtml)
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        '',
        altBlock,
      )
    } else {
      parts.push(
        `--${mixedBoundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
      )
    }

    for (const filePath of attachmentPaths) {
      const fileData = await readFile(filePath)
      const filename = basename(filePath)
      const mimeType = mimeTypeFromPath(filePath)
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: ${mimeType}; name="${filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${filename}"`,
        '',
        fileData.toString('base64'),
      )
    }

    parts.push(`--${mixedBoundary}--`)

    const message = [
      `To: ${to}`,
      ...ccHeader,
      `Subject: ${encodeMimeHeader(subject)}`,
      ...replyHeaders,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      parts.join('\r\n'),
    ].join('\r\n')

    raw = Buffer.from(message).toString('base64url')
  }

  const requestBody = { raw }
  if (threadId) requestBody.threadId = threadId

  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody,
  })

  return { sent: true, messageId: data.id, threadId: data.threadId, labelIds: data.labelIds }
}

/**
 * Delete a Gmail draft by draft ID.
 */
export async function deleteGmailDraft(auth, draftId) {
  const gmail = google.gmail({ version: 'v1', auth })
  await gmail.users.drafts.delete({ userId: 'me', id: draftId })
  return { deleted: true, draftId }
}

/**
 * Delete a Gmail message permanently (bypasses Trash).
 * Use trash=true to move to Trash instead of permanent delete.
 */
export async function deleteGmailMessage(auth, messageId, trash = false) {
  const gmail = google.gmail({ version: 'v1', auth })
  if (trash) {
    const { data } = await gmail.users.messages.trash({ userId: 'me', id: messageId })
    return { trashed: true, messageId: data.id }
  }
  await gmail.users.messages.delete({ userId: 'me', id: messageId })
  return { deleted: true, messageId }
}

/**
 * Recursively collect attachment metadata from a Gmail message payload.
 * Returns an array of { filename, mimeType, attachmentId, size }.
 */
function extractAttachments(payload, results = []) {
  if (!payload) return results

  if (payload.filename && payload.body?.attachmentId) {
    results.push({
      filename: payload.filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      attachmentId: payload.body.attachmentId,
      size: payload.body.size || 0,
    })
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      extractAttachments(part, results)
    }
  }

  return results
}

/**
 * Download a Gmail attachment and save it to disk.
 * Returns { filename, mimeType, size, savedTo }.
 */
export async function downloadGmailAttachment(auth, messageId, attachmentId, savePath) {
  const gmail = google.gmail({ version: 'v1', auth })
  const { data } = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  })

  const buffer = Buffer.from(data.data, 'base64url')

  const { writeFile, mkdir } = await import('fs/promises')
  const { dirname } = await import('path')
  await mkdir(dirname(savePath), { recursive: true })
  await writeFile(savePath, buffer)

  return { size: buffer.length, savedTo: savePath }
}

/**
 * Convert HTML to readable plain text, preserving hyperlinks as "text (URL)".
 */
function htmlToText(html) {
  return html
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = text.replace(/<[^>]+>/g, '').trim()
      return label ? `${label} (${href})` : href
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Recursively extract plain text body from a Gmail message payload.
 * Handles both text/plain and text/html (including HTML-only emails).
 */
function extractBody(payload) {
  if (!payload) return ''

  // Single-part: plain text
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8')
  }

  // Single-part: HTML-only email (no multipart wrapper)
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return htmlToText(Buffer.from(payload.body.data, 'base64').toString('utf8'))
  }

  if (payload.parts) {
    // Prefer text/plain, fall back to text/html
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain')
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, 'base64').toString('utf8')
    }
    const html = payload.parts.find((p) => p.mimeType === 'text/html')
    if (html?.body?.data) {
      return htmlToText(Buffer.from(html.body.data, 'base64').toString('utf8'))
    }
    // Recurse into nested parts (handles multipart/related, multipart/mixed, etc.)
    for (const part of payload.parts) {
      const text = extractBody(part)
      if (text) return text
    }
  }

  return ''
}
