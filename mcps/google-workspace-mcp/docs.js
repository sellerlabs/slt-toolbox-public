/**
 * docs.js — Google Docs API tool implementations
 */

// Scoped clients instead of the `googleapis` meta-package — see note in gmail.js.
// This file uses both docs and drive (drive for folder placement).
import { docs as docsApi } from '@googleapis/docs'
import { drive as driveApi } from '@googleapis/drive'
const google = { docs: docsApi, drive: driveApi }

/**
 * Flatten a Docs `body.content` array into plain text.
 */
function extractText(content) {
  let out = ''
  for (const el of content || []) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements || []) {
        if (pe.textRun?.content) out += pe.textRun.content
      }
    } else if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          out += extractText(cell.content)
        }
      }
    } else if (el.tableOfContents) {
      out += extractText(el.tableOfContents.content)
    }
  }
  return out
}

/**
 * Create a new native Google Doc.
 * @param {string} title - Document title
 * @param {string} [initialText] - Optional body text written at the top of the new doc
 * @param {string} [folderId] - Optional Drive folder to move the new doc into
 */
export async function createDoc(auth, title, initialText, folderId) {
  const docs = google.docs({ version: 'v1', auth })

  const { data } = await docs.documents.create({ requestBody: { title } })
  const documentId = data.documentId

  if (initialText) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{
          insertText: {
            endOfSegmentLocation: { segmentId: '' },
            text: initialText,
          },
        }],
      },
    })
  }

  if (folderId) {
    const drive = google.drive({ version: 'v3', auth })
    const { data: meta } = await drive.files.get({ fileId: documentId, fields: 'parents' })
    const prevParents = (meta.parents || []).join(',')
    await drive.files.update({
      fileId: documentId,
      addParents: folderId,
      removeParents: prevParents || undefined,
      fields: 'id, parents',
    })
  }

  return {
    id: documentId,
    title: data.title,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  }
}

/**
 * Read an existing Google Doc as plain text.
 * @param {string} documentId - Google Docs document ID
 */
export async function readDoc(auth, documentId) {
  const docs = google.docs({ version: 'v1', auth })
  const { data } = await docs.documents.get({ documentId })
  const text = extractText(data.body?.content)
  return {
    id: data.documentId,
    title: data.title,
    url: `https://docs.google.com/document/d/${data.documentId}/edit`,
    characterCount: text.length,
    text,
  }
}

/**
 * Append text to the END of an existing Google Doc, non-destructively.
 * Uses endOfSegmentLocation so no index arithmetic is required — existing
 * content is never overwritten.
 * @param {string} documentId - Google Docs document ID
 * @param {string} text - Text to append (newlines are honored)
 */
export async function appendToDoc(auth, documentId, text) {
  const docs = google.docs({ version: 'v1', auth })

  const { data } = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{
        insertText: {
          endOfSegmentLocation: { segmentId: '' },
          text,
        },
      }],
    },
  })

  return {
    id: data.documentId,
    appendedCharacters: text.length,
    url: `https://docs.google.com/document/d/${data.documentId}/edit`,
  }
}

/**
 * Find-and-replace text throughout an existing Google Doc.
 * @param {string} documentId - Google Docs document ID
 * @param {Array<{find: string, replace: string, matchCase?: boolean}>} replacements
 */
export async function replaceTextInDoc(auth, documentId, replacements) {
  const docs = google.docs({ version: 'v1', auth })

  const requests = replacements.map(r => ({
    replaceAllText: {
      containsText: { text: r.find, matchCase: r.matchCase ?? true },
      replaceText: r.replace,
    },
  }))

  const { data } = await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests },
  })

  const occurrences = (data.replies || []).map((reply, i) => ({
    find: replacements[i].find,
    occurrencesChanged: reply.replaceAllText?.occurrencesChanged || 0,
  }))

  return {
    id: data.documentId,
    replacements: occurrences,
    url: `https://docs.google.com/document/d/${data.documentId}/edit`,
  }
}
