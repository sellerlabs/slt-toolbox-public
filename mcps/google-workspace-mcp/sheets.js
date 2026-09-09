/**
 * sheets.js — Google Sheets API tool implementations
 */

// Scoped clients instead of the `googleapis` meta-package — see note in gmail.js.
// This file uses both sheets and drive (drive for file lookup/conversion).
import { sheets as sheetsApi } from '@googleapis/sheets'
import { drive as driveApi } from '@googleapis/drive'
const google = { sheets: sheetsApi, drive: driveApi }

/**
 * Create a new native Google Sheet.
 * @param {string} title - Spreadsheet title
 * @param {string[]} [sheetTitles] - Names of tabs to create (defaults to one "Sheet1")
 * @param {Array<Array<any>>} [initialValues] - Optional 2D array written to the first tab starting at A1
 * @param {string} [folderId] - Optional Drive folder to move the new sheet into
 */
export async function createSpreadsheet(auth, title, sheetTitles, initialValues, folderId) {
  const sheets = google.sheets({ version: 'v4', auth })

  const tabs = (sheetTitles && sheetTitles.length ? sheetTitles : ['Sheet1'])
    .map((t, i) => ({ properties: { title: t, index: i } }))

  const { data } = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: tabs,
    },
    fields: 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties',
  })

  const spreadsheetId = data.spreadsheetId
  const firstTab = data.sheets[0].properties.title

  // Seed initial values into the first tab, if provided.
  if (initialValues && initialValues.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${firstTab}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: initialValues },
    })
  }

  // Optionally move into a target folder.
  if (folderId) {
    const drive = google.drive({ version: 'v3', auth })
    const { data: meta } = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' })
    const prevParents = (meta.parents || []).join(',')
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: folderId,
      removeParents: prevParents || undefined,
      fields: 'id, parents',
    })
  }

  return {
    id: spreadsheetId,
    title: data.properties.title,
    url: data.spreadsheetUrl,
    sheets: (data.sheets || []).map(s => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      index: s.properties.index,
    })),
  }
}

/**
 * Convert an existing Drive file (e.g. an uploaded CSV) into a native Google Sheet.
 * Creates a NEW native Sheet from the source and leaves the original untouched.
 * Returns a stable spreadsheet ID that the sheets_* write tools can target.
 * @param {string} sourceFileId - Drive file ID of the CSV (or other importable file)
 * @param {string} [title] - Title for the new Sheet (defaults to the source name)
 * @param {string} [folderId] - Optional folder to place the new Sheet in
 */
export async function convertToSheet(auth, sourceFileId, title, folderId) {
  const drive = google.drive({ version: 'v3', auth })

  const { data: src } = await drive.files.get({
    fileId: sourceFileId,
    fields: 'id, name, mimeType',
  })

  const metadata = {
    name: title || src.name.replace(/\.csv$/i, ''),
    mimeType: 'application/vnd.google-apps.spreadsheet',
  }
  if (folderId) metadata.parents = [folderId]

  // copy() with a Google mimeType triggers server-side conversion (CSV -> Sheet).
  const { data } = await drive.files.copy({
    fileId: sourceFileId,
    requestBody: metadata,
    fields: 'id, name, mimeType, webViewLink, parents',
  })

  return {
    id: data.id,
    title: data.name,
    mimeType: data.mimeType,
    url: data.webViewLink,
    parents: data.parents || [],
    sourceFileId,
  }
}

/**
 * Get spreadsheet metadata and sheet names.
 */
export async function getSpreadsheetInfo(auth, spreadsheetId) {
  const sheets = google.sheets({ version: 'v4', auth })
  const { data } = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'spreadsheetId,properties.title,sheets.properties',
  })
  return {
    id: data.spreadsheetId,
    title: data.properties.title,
    sheets: (data.sheets || []).map(s => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      index: s.properties.index,
      rowCount: s.properties.gridProperties?.rowCount,
      columnCount: s.properties.gridProperties?.columnCount,
    })),
  }
}

/**
 * Parse the 1-based starting row number out of an A1 range string as returned by
 * the Sheets API (e.g. "'Will AI Audit - Outreach Tracker'!D5:T20" -> 5,
 * "Sheet1!A1:D10" -> 1, "A2:Z100" -> 2). Returns null if no leading row number is
 * present (e.g. a whole-column range like "A:D", where rows are unbounded).
 *
 * The tab name may be quoted and can itself contain "!" or digits, so we strip the
 * tab prefix at the LAST "!" first, then read the first cell's row number from the
 * remaining "<colLetters><rowNumber>..." portion.
 */
export function startRowOf(a1Range) {
  if (!a1Range || typeof a1Range !== 'string') return null
  const bang = a1Range.lastIndexOf('!')
  const cellPart = bang === -1 ? a1Range : a1Range.slice(bang + 1)
  // First cell in the range is before any ":"; pull the trailing digits of its A1 ref.
  const firstCell = cellPart.split(':')[0]
  const m = /([0-9]+)\s*$/.exec(firstCell)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Read a range of cells from a sheet.
 * range example: "Sheet1!A1:D10" or just "A1:D10" (defaults to first sheet)
 *
 * ROW-NUMBER SAFETY: in addition to the raw `values` 2D array, this returns a
 * `rows` array where each element is { row: <actual 1-based sheet row>, values: [...] }.
 * The row number is computed IN CODE from the API's echoed `range`, so callers never
 * have to derive a sheet row by counting array indices or adding an offset to the
 * range start — the #1 source of wrong-row writes. Always take the target row from
 * `rows[i].row`, never by computing `startRow + arrayIndex` yourself.
 *
 * valueRenderOption: 'FORMATTED_VALUE' (default, display strings), 'UNFORMATTED_VALUE'
 * (raw numbers, no currency/percent formatting), or 'FORMULA' (underlying formulas).
 */
export async function readSheetRange(auth, spreadsheetId, range, valueRenderOption = 'FORMATTED_VALUE') {
  const sheets = google.sheets({ version: 'v4', auth })
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption,
    dateTimeRenderOption: 'FORMATTED_STRING',
  })
  const values = data.values || []
  const start = startRowOf(data.range)
  // When the range has a concrete start row, tag each returned row with its true
  // sheet row number. If start is null (unbounded column range), row stays null.
  const rows = values.map((v, i) => ({
    row: start === null ? null : start + i,
    values: v,
  }))
  return {
    range: data.range,
    startRow: start,
    rows,
    values,
    rowCount: values.length,
    colCount: Math.max(0, ...values.map(r => r.length)),
  }
}

/**
 * Write values to a range of cells.
 * values is a 2D array, e.g. [["Name", "Age"], ["Alice", 30]]
 */
export async function writeSheetRange(auth, spreadsheetId, range, values) {
  const sheets = google.sheets({ version: 'v4', auth })
  const { data } = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  })
  return {
    updatedRange: data.updatedRange,
    updatedRows: data.updatedRows,
    updatedColumns: data.updatedColumns,
    updatedCells: data.updatedCells,
  }
}

/**
 * Append rows to a sheet (adds below the last row with data).
 * values is a 2D array.
 */
export async function appendSheetRows(auth, spreadsheetId, range, values) {
  const sheets = google.sheets({ version: 'v4', auth })
  const { data } = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  })
  return {
    tableRange: data.tableRange,
    updatedRange: data.updates?.updatedRange,
    updatedRows: data.updates?.updatedRows,
    updatedCells: data.updates?.updatedCells,
  }
}

/**
 * Clear a range of cells (removes values, keeps formatting).
 */
export async function clearSheetRange(auth, spreadsheetId, range) {
  const sheets = google.sheets({ version: 'v4', auth })
  const { data } = await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range,
  })
  return {
    spreadsheetId: data.spreadsheetId,
    clearedRange: data.clearedRange,
  }
}

/**
 * Insert blank rows into a sheet, shifting existing rows DOWN (does not overwrite).
 * Uses the Sheets insertDimension batchUpdate. Optionally writes values into the
 * newly-created blank rows in the same logical operation.
 *
 * @param {string} spreadsheetId
 * @param {number} startIndex - 0-based row index to insert BEFORE. 0 = insert at the very top.
 * @param {number} [numRows=1] - How many blank rows to insert.
 * @param {string} [sheetName] - Tab name to insert into (defaults to the first tab).
 * @param {Array<Array<any>>} [values] - Optional 2D array to write into the new blank rows.
 * @param {boolean} [inheritFromBefore=false] - If true, new rows inherit formatting from the row above; otherwise from the row below.
 */
export async function insertRows(auth, spreadsheetId, startIndex, numRows = 1, sheetName, values, inheritFromBefore = false) {
  const sheets = google.sheets({ version: 'v4', auth })

  // Resolve the tab name -> numeric sheetId (insertDimension requires the numeric id).
  const { data: meta } = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,index)',
  })
  const props = (meta.sheets || []).map(s => s.properties)
  const target = sheetName
    ? props.find(p => p.title === sheetName)
    : props.find(p => p.index === 0) || props[0]
  if (!target) {
    throw new Error(sheetName ? `Sheet tab "${sheetName}" not found` : 'No sheets found in spreadsheet')
  }
  const sheetId = target.sheetId

  const rows = Math.max(1, numRows)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex,
            endIndex: startIndex + rows,
          },
          inheritFromBefore,
        },
      }],
    },
  })

  let write
  // If values supplied, write them into the freshly-inserted blank rows.
  if (values && values.length) {
    const firstRow = startIndex + 1 // A1 notation is 1-based
    const range = `${target.title}!A${firstRow}`
    const { data } = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    })
    write = {
      updatedRange: data.updatedRange,
      updatedRows: data.updatedRows,
      updatedCells: data.updatedCells,
    }
  }

  return {
    spreadsheetId,
    sheet: target.title,
    sheetId,
    insertedRows: rows,
    insertedBeforeRowIndex: startIndex,
    ...(write ? { write } : {}),
  }
}

/**
 * Batch write multiple ranges in a single API call.
 * updates: array of { range, values } objects
 */
export async function batchWriteSheet(auth, spreadsheetId, updates) {
  const sheets = google.sheets({ version: 'v4', auth })
  const { data } = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates.map(u => ({ range: u.range, values: u.values })),
    },
  })
  return {
    spreadsheetId: data.spreadsheetId,
    totalUpdatedCells: data.totalUpdatedCells,
    totalUpdatedRows: data.totalUpdatedRows,
    responses: (data.responses || []).map(r => ({
      updatedRange: r.updatedRange,
      updatedRows: r.updatedRows,
      updatedCells: r.updatedCells,
    })),
  }
}
