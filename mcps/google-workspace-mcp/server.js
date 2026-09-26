/**
 * server.js — Google Workspace MCP Server
 *
 * Exposes Gmail, Google Calendar, and Google Drive tools for multiple accounts.
 * Compatible with Claude Code (.mcp.json) and OpenClaw (openclaw.json).
 *
 * Transport: stdio (JSON-RPC 2.0)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { listAccounts, resolveAccounts } from './auth.js'
import { searchGmail, listGmail, readGmail, createGmailDraft, sendGmailDraft, getOrCreateLabel, renameGmailLabel, modifyGmailMessage, modifyGmailThread, downloadGmailAttachment, deleteGmailDraft, deleteGmailMessage } from './gmail.js'
import { resolve as resolvePath } from 'path'
import { homedir } from 'os'

const ATTACHMENT_ALLOWED_DIRS = [
  resolvePath(homedir(), 'Downloads'),
  resolvePath(homedir(), 'OneDrive', 'SLT App', 'Claude Code', 'temp'),
  resolvePath(process.env.TEMP || resolvePath(homedir(), 'AppData', 'Local', 'Temp')),
]

const DEFAULT_DRIVE_SAVE_DIR = resolvePath(
  process.env.TEMP || resolvePath(homedir(), 'AppData', 'Local', 'Temp')
)

// Validate that a target DIRECTORY is inside an allowed root (used by drive_read_file).
function validateSaveDir(dir) {
  const resolved = resolvePath(dir)
  const allowed = ATTACHMENT_ALLOWED_DIRS.some(root =>
    resolved === root || resolved.startsWith(root + '\\') || resolved.startsWith(root + '/')
  )
  if (!allowed) {
    throw new Error(
      `saveDir must be within Downloads, temp, or system temp. Got: ${resolved}`
    )
  }
  return resolved
}

function validateSavePath(savePath) {
  const resolved = resolvePath(savePath)
  const allowed = ATTACHMENT_ALLOWED_DIRS.some(dir =>
    resolved === dir || resolved.startsWith(dir + '\\') || resolved.startsWith(dir + '/')
  )
  if (!allowed) {
    throw new Error(
      `savePath must be within Downloads, temp, or system temp. Got: ${resolved}`
    )
  }
  return resolved
}
import { listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, findFreeTime } from './calendar.js'
import { searchDrive, listDriveFiles, readDriveFile, uploadDriveFile, convertToDoc, moveDriveFile, renameDriveFile, createDriveFolder } from './drive.js'
import { createSpreadsheet, convertToSheet, getSpreadsheetInfo, readSheetRange, writeSheetRange, appendSheetRows, insertRows, insertColumns, moveColumns, setCellColor, readSheetFormat, clearSheetRange, batchWriteSheet } from './sheets.js'
import { createDoc, readDoc, appendToDoc, replaceTextInDoc } from './docs.js'
import { createPresentation, getPresentation, addSlide, setSlideText, deleteSlide, setSpeakerNotes } from './slides.js'

const server = new McpServer({
  name: 'google-workspace',
  version: '1.0.0',
})

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatAccountResults(results) {
  if (results.length === 1) return results[0].data
  return results.map(({ nickname, email, data }) => ({
    account: `${nickname} (${email})`,
    results: data,
  }))
}

async function runAcrossAccounts(accountArg, fn) {
  const targets = resolveAccounts(accountArg || undefined)
  const results = await Promise.all(
    targets.map(async ({ nickname, auth }) => {
      const accounts = listAccounts()
      const email = accounts.find((a) => a.nickname === nickname)?.email || nickname
      const data = await fn(auth)
      return { nickname, email, data }
    })
  )
  return results
}

// ─── Account Management ────────────────────────────────────────────────────

server.tool(
  'google_list_accounts',
  'List all connected Google accounts with their nicknames and emails',
  {},
  async () => {
    const accounts = listAccounts()
    if (accounts.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Google accounts connected.\n\nRun: node setup.js add <nickname>\nExample: node setup.js add work',
        }],
      }
    }
    const list = accounts.map((a) => {
      const aliasNote = a.aliases && a.aliases.length ? ` [aliases: ${a.aliases.join(', ')}]` : ''
      return `• ${a.nickname}: ${a.email}${aliasNote}`
    }).join('\n')
    return { content: [{ type: 'text', text: `Connected Google accounts:\n${list}` }] }
  }
)

// ─── Gmail Tools ───────────────────────────────────────────────────────────

server.tool(
  'gmail_search',
  'Search Gmail messages. Searches all connected accounts if no account specified.',
  {
    query: z.string().describe('Gmail search query (same syntax as Gmail search bar)'),
    account: z.string().optional().describe('Account nickname, email, or alias (e.g. "work", "you@example.com"). Omit to search all accounts.'),
    maxResults: z.number().optional().default(20).describe('Max results per account (default: 20)'),
  },
  async ({ query, account, maxResults }) => {
    const results = await runAcrossAccounts(account, (auth) => searchGmail(auth, query, maxResults))
    const data = formatAccountResults(results)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'gmail_list',
  'List emails in a Gmail label. Searches all connected accounts if no account specified.',
  {
    label: z.string().optional().default('INBOX').describe('Gmail label (INBOX, SENT, UNREAD, STARRED, etc.)'),
    account: z.string().optional().describe('Account nickname, email, or alias. Omit to list from all accounts.'),
    maxResults: z.number().optional().default(20).describe('Max results per account (default: 20)'),
  },
  async ({ label, account, maxResults }) => {
    const results = await runAcrossAccounts(account, (auth) => listGmail(auth, label, maxResults))
    const data = formatAccountResults(results)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'gmail_read',
  'Read a full Gmail message by ID, including the body.',
  {
    messageId: z.string().describe('Gmail message ID (from gmail_search or gmail_list results)'),
    account: z.string().describe('Account nickname, email, or alias that owns this message (required)'),
  },
  async ({ messageId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const message = await readGmail(auth, messageId)
    return { content: [{ type: 'text', text: JSON.stringify(message, null, 2) }] }
  }
)

server.tool(
  'gmail_get_attachment',
  'Download a Gmail attachment and save it to a local file path. Get the attachmentId from gmail_read results.',
  {
    messageId: z.string().describe('Gmail message ID that contains the attachment'),
    attachmentId: z.string().describe('Attachment ID from gmail_read attachments list'),
    savePath: z.string().describe('Full local file path to save the attachment (e.g. "<USER_HOME>/Downloads/file.pdf")'),
    account: z.string().describe('Account nickname, email, or alias that owns this message (required)'),
  },
  async ({ messageId, attachmentId, savePath, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const validatedPath = validateSavePath(savePath)
    const result = await downloadGmailAttachment(auth, messageId, attachmentId, validatedPath)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'gmail_create_draft',
  'Create a Gmail draft (does not send — saves as draft only). Supports HTML body with hyperlinks. Optionally attach local files or add CC recipients.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body in plain text. If you need rich formatting (links, bold, lists), use bodyHtml instead. HTML in body is auto-detected and rendered correctly.'),
    bodyHtml: z.string().optional().describe('HTML version of the body for rich formatting (hyperlinks, bold, etc). When provided, the email renders as HTML. Use standard HTML tags like <a href="...">, <b>, <p>, <br>.'),
    cc: z.string().optional().describe('CC email address(es), comma-separated (e.g. "foo@bar.com, baz@bar.com")'),
    account: z.string().describe('Account nickname, email, or alias to send from (required)'),
    attachments: z.array(z.string()).optional().default([]).describe('List of absolute local file paths to attach (e.g. ["<USER_HOME>/Downloads/invoice.pdf"])'),
    threadId: z.string().optional().describe('Gmail thread ID to attach this draft to (makes it appear as a reply in the same thread)'),
    replyToMessageId: z.string().optional().describe('Gmail message ID to reply to (sets In-Reply-To and References headers for proper threading)'),
  },
  async ({ to, subject, body, bodyHtml, cc, account, attachments, threadId, replyToMessageId }) => {
    const [{ auth }] = resolveAccounts(account)
    const draft = await createGmailDraft(auth, to, subject, body, attachments, threadId, replyToMessageId, bodyHtml, cc)
    return { content: [{ type: 'text', text: JSON.stringify(draft, null, 2) }] }
  }
)

server.tool(
  'gmail_send_draft',
  'Send an existing Gmail draft by its draft ID. IMPORTANT: Always show the full draft content to the user and wait for explicit "send it" confirmation before calling this tool. Use the draftId from gmail_create_draft results.',
  {
    draftId: z.string().describe('Draft ID to send (from gmail_create_draft results)'),
    account: z.string().describe('Account nickname, email, or alias that owns this draft (required)'),
  },
  async ({ draftId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await sendGmailDraft(auth, draftId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'gmail_rename_label',
  'Rename an existing Gmail label by its ID.',
  {
    labelId: z.string().describe('Label ID to rename (from gmail_create_label or gmail_list)'),
    newName: z.string().describe('New label name'),
    account: z.string().describe('Account nickname, email, or alias (required)'),
  },
  async ({ labelId, newName, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await renameGmailLabel(auth, labelId, newName)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

server.tool(
  'gmail_modify_thread',
  'Modify labels on an entire Gmail thread at once — marks all messages in the thread as read/unread, applies or removes labels.',
  {
    threadId: z.string().describe('Gmail thread ID (from gmail_search or gmail_list results)'),
    account: z.string().describe('Account nickname, email, or alias that owns this thread (required)'),
    addLabelIds: z.array(z.string()).optional().default([]).describe('Label IDs to add to all messages in the thread'),
    removeLabelIds: z.array(z.string()).optional().default([]).describe('Label IDs to remove from all messages (use "UNREAD" to mark read, "INBOX" to archive)'),
  },
  async ({ threadId, account, addLabelIds, removeLabelIds }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await modifyGmailThread(auth, threadId, addLabelIds, removeLabelIds)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

server.tool(
  'gmail_create_label',
  'Create a Gmail label (tag) if it does not already exist. Returns the label ID.',
  {
    name: z.string().describe('Label name to create (e.g. "Cold Outreach / Sales")'),
    account: z.string().describe('Account nickname, email, or alias (required)'),
  },
  async ({ name, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const labelId = await getOrCreateLabel(auth, name)
    return { content: [{ type: 'text', text: JSON.stringify({ labelId, name }) }] }
  }
)

server.tool(
  'gmail_modify_message',
  'Modify labels on a Gmail message — mark as read, apply a label, remove from inbox, etc.',
  {
    messageId: z.string().describe('Gmail message ID'),
    account: z.string().describe('Account nickname, email, or alias that owns this message (required)'),
    addLabelIds: z.array(z.string()).optional().default([]).describe('Label IDs to add to the message'),
    removeLabelIds: z.array(z.string()).optional().default([]).describe('Label IDs to remove (use "UNREAD" to mark read, "INBOX" to archive)'),
  },
  async ({ messageId, account, addLabelIds, removeLabelIds }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await modifyGmailMessage(auth, messageId, addLabelIds, removeLabelIds)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

server.tool(
  'gmail_delete_draft',
  'Delete a Gmail draft by its draft ID. Use the draftId from gmail_create_draft results.',
  {
    draftId: z.string().describe('Draft ID to delete (from gmail_create_draft or gmail_search with in:drafts)'),
    account: z.string().describe('Account nickname, email, or alias that owns this draft (required)'),
  },
  async ({ draftId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await deleteGmailDraft(auth, draftId)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

server.tool(
  'gmail_delete_message',
  'Delete or trash a Gmail message. By default moves to Trash. Set permanent=true to delete forever (cannot be undone).',
  {
    messageId: z.string().describe('Gmail message ID to delete'),
    account: z.string().describe('Account nickname, email, or alias that owns this message (required)'),
    permanent: z.boolean().optional().default(false).describe('If true, permanently deletes (cannot undo). If false (default), moves to Trash.'),
  },
  async ({ messageId, account, permanent }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await deleteGmailMessage(auth, messageId, !permanent)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

// ─── Calendar Tools ────────────────────────────────────────────────────────

server.tool(
  'calendar_list_events',
  'List upcoming calendar events. Searches all connected accounts if no account specified.',
  {
    startDate: z.string().optional().describe('Start date (ISO 8601 or natural date like "2026-03-11"). Defaults to now.'),
    endDate: z.string().optional().describe('End date (ISO 8601). Defaults to 7 days from now.'),
    account: z.string().optional().describe('Account nickname, email, or alias. Omit to list from all accounts.'),
    maxResults: z.number().optional().default(50).describe('Max results per account'),
  },
  async ({ startDate, endDate, account, maxResults }) => {
    const results = await runAcrossAccounts(account, (auth) => listCalendarEvents(auth, startDate, endDate, maxResults))
    const data = formatAccountResults(results)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'calendar_create_event',
  'Create a new calendar event.',
  {
    title: z.string().describe('Event title'),
    start: z.string().describe('Start datetime (ISO 8601, e.g. "2026-03-15T14:00:00")'),
    end: z.string().describe('End datetime (ISO 8601, e.g. "2026-03-15T15:00:00")'),
    description: z.string().optional().describe('Event description/notes'),
    attendees: z.array(z.string()).optional().describe('List of attendee email addresses'),
    account: z.string().describe('Account nickname, email, or alias to create the event in (required)'),
  },
  async ({ title, start, end, description, attendees, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const event = await createCalendarEvent(auth, { title, start, end, description, attendees })
    return { content: [{ type: 'text', text: JSON.stringify(event, null, 2) }] }
  }
)

server.tool(
  'calendar_update_event',
  'Update an existing calendar event.',
  {
    eventId: z.string().describe('Event ID from calendar_list_events'),
    title: z.string().optional().describe('New title'),
    start: z.string().optional().describe('New start datetime (ISO 8601)'),
    end: z.string().optional().describe('New end datetime (ISO 8601)'),
    description: z.string().optional().describe('New description'),
    attendees: z.array(z.string()).optional().describe('New attendee email list (replaces existing)'),
    account: z.string().describe('Account nickname, email, or alias that owns this event (required)'),
  },
  async ({ eventId, account, ...updates }) => {
    const [{ auth }] = resolveAccounts(account)
    const event = await updateCalendarEvent(auth, eventId, updates)
    return { content: [{ type: 'text', text: JSON.stringify(event, null, 2) }] }
  }
)

server.tool(
  'calendar_delete_event',
  'Delete a calendar event.',
  {
    eventId: z.string().describe('Event ID from calendar_list_events'),
    account: z.string().describe('Account nickname, email, or alias that owns this event (required)'),
  },
  async ({ eventId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await deleteCalendarEvent(auth, eventId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'calendar_find_free_time',
  'Find free time slots on a given day (within 8am–6pm work hours).',
  {
    date: z.string().describe('Date to check (e.g. "2026-03-15")'),
    account: z.string().optional().describe('Account nickname, email, or alias. Omit to check all accounts.'),
  },
  async ({ date, account }) => {
    const results = await runAcrossAccounts(account, (auth) => findFreeTime(auth, date))
    const data = formatAccountResults(results)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// ─── Drive Tools ───────────────────────────────────────────────────────────

server.tool(
  'drive_search',
  'Search for files in Google Drive. Terms in `query` are AND-ed, and each term is matched against both file content and file name. Wrap words in double quotes to force an exact phrase. Results come back in Drive relevance order (same ranking as the Drive web UI) unless `orderBy` is set. Do not put Drive query syntax in `query` — use `rawQuery` for that.',
  {
    query: z.string().describe('Plain-language search query. Terms are AND-ed across file content and name; "quoted text" is an exact phrase.'),
    account: z.string().optional().describe('Account nickname, email, or alias. Omit to search all accounts.'),
    maxResults: z.number().optional().default(20).describe('Max results per account'),
    rawQuery: z.string().optional().describe("Hand-written Drive API query string (e.g. \"name contains 'Pricing' and trashed = false\"). Overrides `query` entirely."),
    orderBy: z.string().optional().describe("Drive orderBy, e.g. 'modifiedTime desc'. Omit for relevance ranking; setting this disables relevance ranking."),
  },
  async ({ query, account, maxResults, rawQuery, orderBy }) => {
    const results = await runAcrossAccounts(account, (auth) => searchDrive(auth, query, maxResults, { rawQuery, orderBy }))
    const data = formatAccountResults(results)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'drive_list_files',
  'List files in a Google Drive folder (or root if no folder specified).',
  {
    folderId: z.string().optional().describe('Drive folder ID. Omit to list root Drive.'),
    account: z.string().optional().describe('Account nickname, email, or alias. Omit to list from all accounts.'),
    maxResults: z.number().optional().default(50).describe('Max results per account'),
  },
  async ({ folderId, account, maxResults }) => {
    const results = await runAcrossAccounts(account, (auth) => listDriveFiles(auth, folderId, maxResults))
    const data = formatAccountResults(results)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'drive_read_file',
  'Read the content of a Google Drive file. Google Docs/Sheets/Slides are exported as text/CSV; plain-text/code files return their content directly. Binary files (PDF, images, office docs) are downloaded and saved to disk, and the returned savedTo path can be opened with the Read tool (which renders PDFs and images).',
  {
    fileId: z.string().describe('Drive file ID from drive_search or drive_list_files'),
    account: z.string().describe('Account nickname, email, or alias that owns this file (required)'),
    saveDir: z.string().optional().describe('Directory to save binary files (PDF/image/etc.) into. Must be within Downloads, temp, or system temp. Defaults to the system temp folder.'),
  },
  async ({ fileId, account, saveDir }) => {
    const [{ auth }] = resolveAccounts(account)
    const targetDir = saveDir ? validateSaveDir(saveDir) : DEFAULT_DRIVE_SAVE_DIR
    const file = await readDriveFile(auth, fileId, targetDir)
    return { content: [{ type: 'text', text: JSON.stringify(file, null, 2) }] }
  }
)

server.tool(
  'drive_upload_file',
  'Upload a local file to Google Drive.',
  {
    localPath: z.string().describe('Absolute local file path to upload (e.g. "<USER_HOME>/Downloads/report.pdf")'),
    account: z.string().describe('Account nickname, email, or alias to upload to (required)'),
    folderId: z.string().optional().describe('Drive folder ID to upload into. Omit to upload to Drive root.'),
    fileName: z.string().optional().describe('Override the file name in Drive. Defaults to the local file name.'),
    mimeType: z.string().optional().describe('MIME type (e.g. "text/plain", "application/pdf"). Auto-detected if omitted.'),
  },
  async ({ localPath, account, folderId, fileName, mimeType }) => {
    const [{ auth }] = resolveAccounts(account)
    const file = await uploadDriveFile(auth, localPath, folderId, fileName, mimeType)
    return { content: [{ type: 'text', text: JSON.stringify(file, null, 2) }] }
  }
)

server.tool(
  'drive_convert_to_doc',
  'Convert an existing Drive file (e.g. an uploaded .md or .txt) into a NEW native Google Doc. Leaves the original file untouched, so after converting you will have both the raw source and the Doc. Upload the source with mimeType "text/markdown" via drive_upload_file so markdown headings become real Doc heading styles.',
  {
    sourceFileId: z.string().describe('Drive file ID of the source file (e.g. the uploaded .md)'),
    title: z.string().optional().describe('Title for the new Doc. Defaults to the source file name with its extension stripped.'),
    folderId: z.string().optional().describe('Optional Drive folder ID to place the new Doc in.'),
    account: z.string().describe('Account nickname, email, or alias that owns the source file (required)'),
  },
  async ({ sourceFileId, title, folderId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await convertToDoc(auth, sourceFileId, title, folderId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'drive_move_file',
  'Move an existing Drive file into a different Drive folder. Relocates the SAME file object (the file ID is unchanged) by rewriting its parents; it does not copy and does not delete. Note that Drive allows duplicate file names within one folder, so moving several same-named files into one destination will not error.',
  {
    fileId: z.string().describe('Drive file ID of the file to move'),
    targetFolderId: z.string().describe('Drive folder ID to move the file into'),
    account: z.string().describe('Account nickname, email, or alias that owns the file (required)'),
  },
  async ({ fileId, targetFolderId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await moveDriveFile(auth, fileId, targetFolderId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'drive_rename_file',
  'Rename an existing Drive file or folder in place. Changes only the name of the SAME object (the file ID, contents, and parent folder are unchanged); it does not copy, move, or re-upload. Use this instead of re-uploading a file just to change its name. Returns `previousName` alongside the new name.',
  {
    fileId: z.string().describe('Drive file ID of the file or folder to rename'),
    newName: z.string().describe('The new name, including the file extension (e.g. "Q3-Report-2026-08-27.pdf")'),
    account: z.string().describe('Account nickname, email, or alias that owns the file (required)'),
  },
  async ({ fileId, newName, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await renameDriveFile(auth, fileId, newName)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'drive_create_folder',
  'Create a new folder in Google Drive. Idempotent: if a non-trashed folder with the same name already exists in the same parent, the existing folder is returned instead of creating a duplicate (Drive would otherwise allow two folders with the same name). The returned `created` flag says which happened.',
  {
    name: z.string().describe('Name for the new folder'),
    parentFolderId: z.string().optional().describe('Drive folder ID to create the folder inside. Omit to create at Drive root.'),
    account: z.string().describe('Account nickname, email, or alias to create the folder under (required)'),
  },
  async ({ name, parentFolderId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await createDriveFolder(auth, name, parentFolderId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// ─── Sheets Tools ──────────────────────────────────────────────────────────

server.tool(
  'sheets_create',
  'Create a new native Google Sheet from scratch. Returns a stable spreadsheet ID (and URL) that the other sheets_* tools can write to. Optionally seed the first tab with initial rows.',
  {
    title: z.string().describe('Title for the new spreadsheet'),
    sheetTitles: z.array(z.string()).optional().describe('Optional list of tab names to create, in order. Defaults to a single "Sheet1".'),
    initialValues: z.array(z.array(z.any())).optional().describe('Optional 2D array written to the first tab starting at A1. Each inner array is a row, e.g. [["Task","Status"],["Deploy","Pending"]]'),
    folderId: z.string().optional().describe('Optional Drive folder ID to place the new sheet in. Defaults to My Drive root.'),
    account: z.string().describe('Account nickname, email, or alias that will own this sheet (required)'),
  },
  async ({ title, sheetTitles, initialValues, folderId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await createSpreadsheet(auth, title, sheetTitles, initialValues, folderId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_convert_from_drive',
  'Convert an existing Drive file (e.g. an uploaded CSV) into a NEW native Google Sheet. Leaves the original file untouched and returns a stable spreadsheet ID the sheets_* write tools can target. Use this to give a runbook a persistent native Sheet to write status updates into.',
  {
    sourceFileId: z.string().describe('Drive file ID of the source file (e.g. the uploaded CSV)'),
    title: z.string().optional().describe('Title for the new Sheet. Defaults to the source file name (with .csv stripped).'),
    folderId: z.string().optional().describe('Optional Drive folder ID to place the new Sheet in.'),
    account: z.string().describe('Account nickname, email, or alias that owns the source file (required)'),
  },
  async ({ sourceFileId, title, folderId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await convertToSheet(auth, sourceFileId, title, folderId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_get_info',
  'Get spreadsheet metadata: title and list of sheet names/IDs. Use this to discover sheet names before reading or writing.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID (from the URL: /spreadsheets/d/<ID>/edit)'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await getSpreadsheetInfo(auth, spreadsheetId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_read',
  'Read cell values from a Google Sheet range. Returns BOTH a raw `values` 2D array AND a `rows` array where each entry is {row: <actual 1-based sheet row>, values: [...]}. IMPORTANT: when you later write to a specific row, take the row number from `rows[i].row` — it is computed in code from the sheet itself. NEVER derive a write row by counting array positions or adding an offset to the range start; that is the top cause of wrong-row writes. Set valueRenderOption to "FORMULA" to see the underlying cell formulas (e.g. "=H8-H7") instead of their computed results, or "UNFORMATTED_VALUE" for raw numbers without currency/percent formatting. NOTE: a FORMULA read and a FORMATTED_VALUE read of the same range can differ in shape for empty cells, so do not zip the two responses together positionally.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 notation range, e.g. "Sheet1!A1:D10" or "A1:Z100". Include sheet name for multi-sheet files.'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional().describe('How to render cell values. Default FORMATTED_VALUE (display strings). Use FORMULA to read underlying formulas, UNFORMATTED_VALUE for raw numbers.'),
  },
  async ({ spreadsheetId, range, account, valueRenderOption }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await readSheetRange(auth, spreadsheetId, range, valueRenderOption)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_write',
  'Write values to a range of cells in a Google Sheet. Overwrites existing content in the range.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 notation range to write to, e.g. "Sheet1!A1" or "Sheet1!B2:D4". The range defines the top-left starting cell; extra rows/columns expand automatically.'),
    values: z.array(z.array(z.any())).describe('2D array of values to write. Each inner array is a row. Example: [["Name", "Age"], ["Alice", 30]]'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, range, values, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await writeSheetRange(auth, spreadsheetId, range, values)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_append',
  'Append rows to a Google Sheet below the last row that contains data.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 notation range indicating the sheet/table to append to, e.g. "Sheet1!A1". The API finds the first empty row after existing data.'),
    values: z.array(z.array(z.any())).describe('2D array of rows to append. Example: [["2026-04-16", "New entry", 99]]'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, range, values, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await appendSheetRows(auth, spreadsheetId, range, values)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_insert_rows',
  'Insert blank rows into a sheet, shifting existing rows DOWN (never overwrites). Unlike sheets_write/sheets_batch_write (which overwrite a range in place), this physically inserts new rows via insertDimension. Optionally writes values into the newly-created rows. Use this to prepend rows at the top of a sheet, e.g. inserting a new weekly block above existing data.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    startIndex: z.number().int().min(0).describe('0-based row index to insert BEFORE. 0 = insert at the very top (above row 1). To insert before row 5 (1-based), pass 4.'),
    numRows: z.number().int().min(1).optional().describe('Number of blank rows to insert (default 1)'),
    sheetName: z.string().optional().describe('Tab name to insert into (defaults to the first tab)'),
    values: z.array(z.array(z.any())).optional().describe('Optional 2D array to write into the newly-inserted blank rows, starting at column A of the first new row'),
    inheritFromBefore: z.boolean().optional().describe('If true, new rows inherit formatting from the row above; otherwise from the row below (default false). Set false when inserting at the very top (startIndex 0).'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, startIndex, numRows, sheetName, values, inheritFromBefore, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await insertRows(auth, spreadsheetId, startIndex, numRows, sheetName, values, inheritFromBefore)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_insert_columns',
  'Insert blank columns into a sheet, shifting existing columns RIGHT (never overwrites). Use this to add a column in the middle of a table (sheets_write can only fill existing cells). Optionally writes values (e.g. a header) into the new columns starting at row 1.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    startColumn: z.union([z.string(), z.number().int().min(0)]).describe('Column to insert BEFORE: an A1 letter like "I", or a 0-based index like 8. "A" or 0 = insert at the far left.'),
    numColumns: z.number().int().min(1).optional().describe('Number of blank columns to insert (default 1)'),
    sheetName: z.string().optional().describe('Tab name to insert into (defaults to the first tab)'),
    values: z.array(z.array(z.any())).optional().describe('Optional 2D array (rows of cells) written into the new columns starting at row 1, e.g. [["New Header"]] for a single header cell'),
    inheritFromBefore: z.boolean().optional().describe('If true (default), new columns inherit formatting from the column to the LEFT; if false, from the column to the right'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, startColumn, numColumns, sheetName, values, inheritFromBefore, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await insertColumns(auth, spreadsheetId, startColumn, numColumns, sheetName, values, inheritFromBefore)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_move_columns',
  'Move one column (or a block of adjacent columns) to a new position, carrying all values and formatting with it. Name every column by its position BEFORE the move. Example: to put column K right after column H, use sourceStart "K", beforeColumn "I". Returns where the block ended up. Always read back the header row afterwards.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    sourceStart: z.union([z.string(), z.number().int().min(0)]).describe('First column to move: A1 letter like "K" or 0-based index like 10'),
    sourceEnd: z.union([z.string(), z.number().int().min(0)]).optional().describe('Last column to move, INCLUSIVE (defaults to sourceStart, i.e. move one column)'),
    beforeColumn: z.union([z.string(), z.number().int().min(0)]).optional().describe('The block lands immediately before this column, named by its PRE-move position (letter or 0-based index). Required unless toEnd is true.'),
    toEnd: z.boolean().optional().describe('If true, move the block after the last column that holds data in any row (ignores beforeColumn)'),
    sheetName: z.string().optional().describe('Tab name (defaults to the first tab)'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, sourceStart, sourceEnd, beforeColumn, toEnd, sheetName, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await moveColumns(auth, spreadsheetId, sourceStart, sourceEnd, beforeColumn, sheetName, toEnd)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_set_cell_color',
  'Set the background fill color (and optionally the text color) of a range of cells, e.g. highlight a row. Only the color changes: values, number formats, borders and other formatting are untouched. Pass "none" to clear a color.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 range including the tab, e.g. "Main!A5:K5" (one row), "Main!C2" (one cell), "Main!C:C" (whole column), "Main!5:5" (whole row). Tab defaults to the first tab if omitted.'),
    backgroundColor: z.string().optional().describe('Fill color as hex, e.g. "#FFF2CC" (light yellow), "#D9EAD3" (light green), "#F4CCCC" (light red). "none" clears the fill.'),
    textColor: z.string().optional().describe('Optional text color as hex, e.g. "#CC0000". "none" resets to the default.'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, range, backgroundColor, textColor, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await setCellColor(auth, spreadsheetId, range, backgroundColor, textColor)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_read_format',
  'Read cells WITH their formatting: value plus fill color (backgroundColor), text color (textColor) and bold, as hex. Use this to see or verify highlights (sheets_read returns values only), e.g. after sheets_set_cell_color. Rows carry their real 1-based sheet row number and each cell its A1 address. Default white fill / black text are omitted. Shows formatting set on the cell, not conditional-formatting results.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 range including the tab, e.g. "Main!A1:K10". Keep it bounded: formatting output is larger than values.'),
    onlyFormatted: z.boolean().optional().describe('If true, return only cells that have a fill color, text color, or bold (good for "which rows are highlighted?")'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, range, onlyFormatted, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await readSheetFormat(auth, spreadsheetId, range, onlyFormatted)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_clear',
  'Clear all values from a range of cells in a Google Sheet (removes content, keeps formatting).',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 notation range to clear, e.g. "Sheet1!A2:Z100"'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, range, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await clearSheetRange(auth, spreadsheetId, range)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'sheets_batch_write',
  'Write to multiple ranges in a single API call. More efficient than calling sheets_write repeatedly.',
  {
    spreadsheetId: z.string().describe('Google Sheets spreadsheet ID'),
    updates: z.array(z.object({
      range: z.string().describe('A1 notation range, e.g. "Sheet1!A1"'),
      values: z.array(z.array(z.any())).describe('2D array of values for this range'),
    })).describe('List of range+values pairs to write'),
    account: z.string().describe('Account nickname, email, or alias that owns this sheet (required)'),
  },
  async ({ spreadsheetId, updates, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await batchWriteSheet(auth, spreadsheetId, updates)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Docs Tools ------------------------------------------------------------

server.tool(
  'docs_create',
  'Create a new native Google Doc from scratch. Returns a stable document ID (and URL) that the other docs_* tools can target. Optionally seed the body with initial text.',
  {
    title: z.string().describe('Title for the new document'),
    initialText: z.string().optional().describe('Optional body text written at the top of the new doc. Newlines are honored.'),
    folderId: z.string().optional().describe('Optional Drive folder ID to place the new doc in. Defaults to My Drive root.'),
    account: z.string().describe('Account nickname, email, or alias that will own this doc (required)'),
  },
  async ({ title, initialText, folderId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await createDoc(auth, title, initialText, folderId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'docs_read',
  'Read an existing Google Doc as plain text. Use this to inspect a doc before writing to it.',
  {
    documentId: z.string().describe('Google Docs document ID (from the URL: /document/d/<ID>/edit)'),
    account: z.string().describe('Account nickname, email, or alias that owns this doc (required)'),
  },
  async ({ documentId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await readDoc(auth, documentId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'docs_append',
  'Append text to the END of an existing Google Doc. NON-DESTRUCTIVE: existing content is never overwritten. This is the correct tool for adding to a doc that already holds content. Start the text with a newline if you want a blank line before it.',
  {
    documentId: z.string().describe('Google Docs document ID'),
    text: z.string().describe('Text to append at the end of the document body. Newlines are honored.'),
    account: z.string().describe('Account nickname, email, or alias that owns this doc (required)'),
  },
  async ({ documentId, text, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await appendToDoc(auth, documentId, text)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'docs_replace_text',
  'Find-and-replace text throughout an existing Google Doc. Every occurrence of each find string is replaced. Returns how many occurrences changed per replacement.',
  {
    documentId: z.string().describe('Google Docs document ID'),
    replacements: z.array(z.object({
      find: z.string().describe('Exact text to find'),
      replace: z.string().describe('Replacement text (empty string deletes the match)'),
      matchCase: z.boolean().optional().describe('Case-sensitive match. Defaults to true.'),
    })).describe('List of find/replace pairs applied in one batch'),
    account: z.string().describe('Account nickname, email, or alias that owns this doc (required)'),
  },
  async ({ documentId, replacements, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await replaceTextInDoc(auth, documentId, replacements)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Slides Tools ----------------------------------------------------------

server.tool(
  'slides_create',
  'Create a new Google Slides presentation. Returns a stable presentation ID (and URL) plus the default first slide with its placeholder object IDs. Typical flow: slides_create, then slides_add_slide per slide, then slides_set_text using the objectIds returned by each add.',
  {
    title: z.string().describe('Title for the new presentation'),
    folderId: z.string().optional().describe('Optional Drive folder ID to place the new deck in. Defaults to My Drive root.'),
    account: z.string().describe('Account nickname, email, or alias that will own this deck (required)'),
  },
  async ({ title, folderId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await createPresentation(auth, title, folderId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'slides_get',
  'Read a presentation structure: every slide, its element objectIds, placeholder types, and current text. Use this to discover the objectIds that slides_set_text needs.',
  {
    presentationId: z.string().describe('Google Slides presentation ID (from the URL: /presentation/d/<ID>/edit)'),
    account: z.string().describe('Account nickname, email, or alias that owns this deck (required)'),
  },
  async ({ presentationId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await getPresentation(auth, presentationId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'slides_add_slide',
  'Add a slide using a predefined layout and return its new placeholder objectIds, ready for slides_set_text. Common layouts: TITLE (title + subtitle), TITLE_AND_BODY, SECTION_HEADER, TITLE_ONLY, BLANK.',
  {
    presentationId: z.string().describe('Google Slides presentation ID'),
    layout: z.enum(['BLANK', 'CAPTION_ONLY', 'TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS', 'TITLE_ONLY', 'SECTION_HEADER', 'SECTION_TITLE_AND_DESCRIPTION', 'ONE_COLUMN_TEXT', 'MAIN_POINT', 'BIG_NUMBER']).optional().describe('Predefined layout. Defaults to TITLE_AND_BODY.'),
    insertionIndex: z.number().optional().describe('0-based position to insert the slide at. Omit to append at the end.'),
    account: z.string().describe('Account nickname, email, or alias that owns this deck (required)'),
  },
  async ({ presentationId, layout, insertionIndex, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await addSlide(auth, presentationId, layout, insertionIndex)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'slides_set_text',
  'Set text on one or more shape/placeholder objects. REPLACES the existing text in each target object. Get the objectIds from slides_add_slide or slides_get, never guess them. For bullets, pass a single text string with newlines between items.',
  {
    presentationId: z.string().describe('Google Slides presentation ID'),
    items: z.array(z.object({
      objectId: z.string().describe('Shape/placeholder objectId from slides_add_slide or slides_get'),
      text: z.string().describe('Text to set. Newlines create separate paragraphs/bullets.'),
    })).describe('List of objectId+text pairs written in one batch'),
    account: z.string().describe('Account nickname, email, or alias that owns this deck (required)'),
  },
  async ({ presentationId, items, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await setSlideText(auth, presentationId, items)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'slides_set_speaker_notes',
  'Set the speaker notes on a slide. Replaces any existing notes on that slide.',
  {
    presentationId: z.string().describe('Google Slides presentation ID'),
    slideId: z.string().describe('objectId of the slide (from slides_add_slide or slides_get)'),
    text: z.string().describe('Speaker notes text. Newlines are honored.'),
    account: z.string().describe('Account nickname, email, or alias that owns this deck (required)'),
  },
  async ({ presentationId, slideId, text, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await setSpeakerNotes(auth, presentationId, slideId, text)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'slides_delete_slide',
  'Delete a slide from a presentation. Useful for removing the default blank first slide after building the real deck.',
  {
    presentationId: z.string().describe('Google Slides presentation ID'),
    slideId: z.string().describe('objectId of the slide to delete'),
    account: z.string().describe('Account nickname, email, or alias that owns this deck (required)'),
  },
  async ({ presentationId, slideId, account }) => {
    const [{ auth }] = resolveAccounts(account)
    const result = await deleteSlide(auth, presentationId, slideId)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// ─── Start ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
