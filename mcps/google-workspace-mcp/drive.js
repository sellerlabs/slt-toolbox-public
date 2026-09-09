/**
 * drive.js — Google Drive API tool implementations
 */

// Scoped client instead of the `googleapis` meta-package — see note in gmail.js.
import { drive as driveApi } from '@googleapis/drive'
const google = { drive: driveApi }
import { createReadStream, statSync, existsSync } from 'fs'
import { writeFile, mkdir } from 'fs/promises'
import { basename, dirname, join, extname } from 'path'

const EXPORTABLE_TYPES = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

const escapeTerm = (t) => t.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * Build a Drive `q` string from a plain-language query.
 * Each whitespace-separated term is AND-ed, and within a term we OR the
 * full-text match with a filename match so name hits rank in too.
 * Quoted "phrases" are kept intact as a single term.
 */
export function buildDriveQuery(query) {
  const terms = (query.match(/"[^"]+"|\S+/g) || [])
    .map((t) => t.replace(/^"|"$/g, '').trim())
    .filter(Boolean)

  if (!terms.length) return 'trashed = false'

  const clauses = terms.map((t) => {
    const e = escapeTerm(t)
    return `(fullText contains '${e}' or name contains '${e}')`
  })

  return `${clauses.join(' and ')} and trashed = false`
}

/**
 * Search files in Google Drive.
 * - `query` is plain language; terms are AND-ed across content and name.
 * - `rawQuery` bypasses the builder and is passed to the API verbatim, for
 *   hand-written Drive query syntax.
 * - `orderBy` is omitted by default so Drive applies relevance ranking.
 *   Setting it disables relevance ranking.
 */
export async function searchDrive(auth, query, maxResults = 20, options = {}) {
  const drive = google.drive({ version: 'v3', auth })
  const { rawQuery, orderBy } = options

  const params = {
    q: rawQuery || buildDriveQuery(query || ''),
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink, parents)',
  }
  if (orderBy) params.orderBy = orderBy

  const { data } = await drive.files.list(params)

  return (data.files || []).map(formatFile)
}

/**
 * List files in a folder (or Drive root).
 */
export async function listDriveFiles(auth, folderId, maxResults = 50) {
  const drive = google.drive({ version: 'v3', auth })

  const parent = folderId || 'root'
  const { data } = await drive.files.list({
    q: `'${parent}' in parents and trashed = false`,
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
    orderBy: 'folder, name',
  })

  return (data.files || []).map(formatFile)
}

/**
 * Read a file's content from Drive.
 * - Google Docs/Sheets/Slides are exported as text/CSV/text
 * - Binary files return a message indicating they can't be read as text
 * - Text files (txt, md, json, etc.) are returned as-is
 */
export async function readDriveFile(auth, fileId, saveDir) {
  const drive = google.drive({ version: 'v3', auth })

  // Get file metadata first
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, webViewLink',
  })

  const exportMime = EXPORTABLE_TYPES[meta.mimeType]

  if (exportMime) {
    // Google Workspace files — export as text
    const { data } = await drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: 'text' }
    )
    return {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      modifiedTime: meta.modifiedTime,
      content: typeof data === 'string' ? data : JSON.stringify(data),
      exportedAs: exportMime,
    }
  }

  // Plain text / code files
  const textTypes = ['text/', 'application/json', 'application/xml', 'application/javascript']
  const isText = textTypes.some((t) => meta.mimeType.startsWith(t))

  if (isText) {
    const { data } = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    )
    return {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      modifiedTime: meta.modifiedTime,
      content: data,
    }
  }

  // Binary file (PDF, image, office doc, etc.) — download the bytes and save
  // to disk so the caller can open/render it locally (the Read tool renders PDFs).
  const { data } = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  )
  const buffer = Buffer.from(data)

  const targetDir = saveDir || process.env.TEMP || '/tmp'
  const safeName = sanitizeFileName(meta.name, meta.mimeType)
  const savePath = join(targetDir, safeName)

  await mkdir(dirname(savePath), { recursive: true })
  await writeFile(savePath, buffer)

  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    modifiedTime: meta.modifiedTime,
    content: null,
    size: buffer.length,
    savedTo: savePath,
    message: `Binary file (${meta.mimeType}) saved to disk. Open it with the Read tool: ${savePath}`,
    webViewLink: meta.webViewLink,
  }
}

/**
 * Ensure a Drive file name is safe as a local filename and carries a sensible
 * extension based on its mime type (Drive names sometimes lack one).
 */
const MIME_EXT = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

function sanitizeFileName(name, mimeType) {
  let safe = (name || 'drive-file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'drive-file'
  if (!extname(safe) && MIME_EXT[mimeType]) safe += MIME_EXT[mimeType]
  return safe
}

/**
 * Upload a local file to Google Drive.
 * @param {object} auth - OAuth2 client
 * @param {string} localPath - Absolute path to the local file
 * @param {string} [folderId] - Drive folder ID to upload into (optional, defaults to root)
 * @param {string} [fileName] - Override the file name in Drive (optional)
 * @param {string} [mimeType] - MIME type (optional, Drive will auto-detect)
 */
export async function uploadDriveFile(auth, localPath, folderId, fileName, mimeType) {
  if (!existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`)
  }

  const drive = google.drive({ version: 'v3', auth })
  const name = fileName || basename(localPath)

  const metadata = { name }
  if (folderId) metadata.parents = [folderId]

  const media = {
    mimeType: mimeType || 'application/octet-stream',
    body: createReadStream(localPath),
  }

  const { data } = await drive.files.create({
    requestBody: metadata,
    media,
    fields: 'id, name, mimeType, webViewLink, parents',
  })

  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    webViewLink: data.webViewLink,
    parents: data.parents || [],
  }
}

/**
 * Convert an existing Drive file (e.g. an uploaded .md) into a native Google Doc.
 * Creates a NEW native Doc from the source and leaves the original untouched.
 * Upload the source with mimeType 'text/markdown' so headings survive the conversion.
 * @param {object} auth - OAuth2 client
 * @param {string} sourceFileId - Drive file ID of the markdown/text source
 * @param {string} [title] - Title for the new Doc (defaults to the source name, extension stripped)
 * @param {string} [folderId] - Optional folder to place the new Doc in
 */
export async function convertToDoc(auth, sourceFileId, title, folderId) {
  const drive = google.drive({ version: 'v3', auth })

  const { data: src } = await drive.files.get({
    fileId: sourceFileId,
    fields: 'id, name, mimeType',
  })

  const metadata = {
    name: title || src.name.replace(/\.(md|markdown|txt|html?|rtf|docx)$/i, ''),
    mimeType: 'application/vnd.google-apps.document',
  }
  if (folderId) metadata.parents = [folderId]

  // copy() with a Google mimeType triggers server-side conversion (markdown -> Doc).
  const { data } = await drive.files.copy({
    fileId: sourceFileId,
    requestBody: metadata,
    fields: 'id, name, mimeType, webViewLink, parents',
  })

  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    webViewLink: data.webViewLink,
    parents: data.parents || [],
    sourceFileId,
  }
}

/**
 * Move a Drive file into a different folder by rewriting its parents.
 * This relocates the SAME file object (the ID never changes); it does not copy.
 * @param {object} auth - OAuth2 client
 * @param {string} fileId - Drive file ID to move
 * @param {string} targetFolderId - Drive folder ID to move the file into
 */
export async function moveDriveFile(auth, fileId, targetFolderId) {
  const drive = google.drive({ version: 'v3', auth })

  const { data: current } = await drive.files.get({
    fileId,
    fields: 'id, name, parents',
  })

  const previousParents = (current.parents || []).join(',')

  const { data } = await drive.files.update({
    fileId,
    addParents: targetFolderId,
    removeParents: previousParents || undefined,
    fields: 'id, name, mimeType, webViewLink, parents',
  })

  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    webViewLink: data.webViewLink,
    parents: data.parents || [],
    previousParents: current.parents || [],
  }
}

export async function renameDriveFile(auth, fileId, newName) {
  const drive = google.drive({ version: 'v3', auth })

  const { data: current } = await drive.files.get({
    fileId,
    fields: 'id, name',
  })

  const { data } = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: 'id, name, mimeType, size, webViewLink, parents',
  })

  return {
    id: data.id,
    name: data.name,
    previousName: current.name,
    mimeType: data.mimeType,
    size: data.size ? Number(data.size) : null,
    webViewLink: data.webViewLink,
    parents: data.parents || [],
  }
}

export async function createDriveFolder(auth, name, parentFolderId) {
  const drive = google.drive({ version: 'v3', auth })

  const existingQuery = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    parentFolderId ? `'${parentFolderId}' in parents` : "'root' in parents",
  ].join(' and ')

  const { data: found } = await drive.files.list({
    q: existingQuery,
    fields: 'files(id, name, mimeType, webViewLink)',
    pageSize: 1,
  })

  if (found.files && found.files.length > 0) {
    const folder = found.files[0]
    return {
      id: folder.id,
      name: folder.name,
      mimeType: folder.mimeType,
      webViewLink: folder.webViewLink,
      created: false,
    }
  }

  const { data } = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    fields: 'id, name, mimeType, webViewLink',
  })

  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    webViewLink: data.webViewLink,
    created: true,
  }
}

function formatFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    size: file.size ? parseInt(file.size) : null,
    webViewLink: file.webViewLink || '',
    isFolder: file.mimeType === 'application/vnd.google-apps.folder',
  }
}
