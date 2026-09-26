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

/**
 * Convert a column reference to a 0-based index. Accepts a letter ("A", "k", "AA")
 * or a 0-based number (or numeric string).
 */
function columnToIndex(col) {
  if (typeof col === 'number') return col
  const s = String(col).trim()
  if (/^\d+$/.test(s)) return Number(s)
  if (!/^[A-Za-z]+$/.test(s)) throw new Error(`Invalid column reference "${col}" (use a letter like "K" or a 0-based index)`)
  let n = 0
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Convert a 0-based column index to its A1 letter (0 -> "A", 26 -> "AA"). */
function indexToColumn(index) {
  let s = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Resolve a tab name to its properties (defaults to the first tab). */
async function resolveSheetProps(sheets, spreadsheetId, sheetName) {
  const { data: meta } = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,index,gridProperties.columnCount)',
  })
  const props = (meta.sheets || []).map(s => s.properties)
  const target = sheetName
    ? props.find(p => p.title === sheetName)
    : props.find(p => p.index === 0) || props[0]
  if (!target) {
    throw new Error(sheetName ? `Sheet tab "${sheetName}" not found` : 'No sheets found in spreadsheet')
  }
  return target
}

/**
 * Insert blank columns into a sheet, shifting existing columns RIGHT (does not overwrite).
 * Uses the Sheets insertDimension batchUpdate. Optionally writes values into the
 * newly-created blank columns (row-major 2D array starting at row 1 of the first new column).
 *
 * @param {string} spreadsheetId
 * @param {string|number} startColumn - Column to insert BEFORE: a letter ("I") or 0-based index (8).
 * @param {number} [numColumns=1] - How many blank columns to insert.
 * @param {string} [sheetName] - Tab name (defaults to the first tab).
 * @param {Array<Array<any>>} [values] - Optional 2D array (rows of cells) written into the new columns from row 1.
 * @param {boolean} [inheritFromBefore=true] - If true, new columns inherit formatting from the column to the left; otherwise from the right.
 */
export async function insertColumns(auth, spreadsheetId, startColumn, numColumns = 1, sheetName, values, inheritFromBefore = true) {
  const sheets = google.sheets({ version: 'v4', auth })
  const target = await resolveSheetProps(sheets, spreadsheetId, sheetName)
  const sheetId = target.sheetId
  const startIndex = columnToIndex(startColumn)
  const cols = Math.max(1, numColumns)

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: 'COLUMNS', startIndex, endIndex: startIndex + cols },
          // Inserting at column A has no column before it to inherit from.
          inheritFromBefore: startIndex === 0 ? false : inheritFromBefore,
        },
      }],
    },
  })

  let write
  if (values && values.length) {
    const range = `${target.title}!${indexToColumn(startIndex)}1`
    const { data } = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    })
    write = { updatedRange: data.updatedRange, updatedCells: data.updatedCells }
  }

  return {
    spreadsheetId,
    sheet: target.title,
    sheetId,
    insertedColumns: cols,
    insertedAt: `${indexToColumn(startIndex)}${cols > 1 ? `:${indexToColumn(startIndex + cols - 1)}` : ''}`,
    ...(write ? { write } : {}),
  }
}

/**
 * Move one or more adjacent columns (values, formatting, and all) to a new position.
 * Uses the Sheets moveDimension batchUpdate.
 *
 * Semantics: the moved block lands immediately BEFORE `beforeColumn`, where `beforeColumn`
 * is named by its position BEFORE the move (this is exactly the API's destinationIndex).
 * To move after the last column holding data, set toEnd=true instead of passing beforeColumn.
 *
 * @param {string} spreadsheetId
 * @param {string|number} sourceStart - First column to move: letter ("K") or 0-based index (10).
 * @param {string|number} [sourceEnd] - Last column to move, INCLUSIVE (defaults to sourceStart).
 * @param {string|number} [beforeColumn] - Pre-move column the block should land before.
 * @param {string} [sheetName] - Tab name (defaults to the first tab).
 * @param {boolean} [toEnd=false] - Move the block after the last column holding data instead of using beforeColumn.
 */
export async function moveColumns(auth, spreadsheetId, sourceStart, sourceEnd, beforeColumn, sheetName, toEnd = false) {
  const sheets = google.sheets({ version: 'v4', auth })
  const target = await resolveSheetProps(sheets, spreadsheetId, sheetName)
  const sheetId = target.sheetId
  const columnCount = target.gridProperties?.columnCount

  const startIndex = columnToIndex(sourceStart)
  const lastIndex = sourceEnd === undefined || sourceEnd === null || sourceEnd === '' ? startIndex : columnToIndex(sourceEnd)
  if (lastIndex < startIndex) throw new Error('sourceEnd must be at or after sourceStart')
  const endIndex = lastIndex + 1 // exclusive

  let destinationIndex
  if (toEnd) {
    // "End" means after the last column holding data in any row, not the last grid column
    // (sheets carry many empty trailing columns).
    const { data: vals } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${target.title}'` })
    const usedCols = Math.max(0, ...(vals.values || []).map(r => r.length))
    destinationIndex = Math.min(usedCols || columnCount, columnCount)
  } else {
    if (beforeColumn === undefined || beforeColumn === null || beforeColumn === '') {
      throw new Error('Provide beforeColumn, or set toEnd=true')
    }
    destinationIndex = columnToIndex(beforeColumn)
  }
  if (destinationIndex >= startIndex && destinationIndex <= endIndex) {
    throw new Error('beforeColumn falls inside or directly after the moved block, so nothing would move')
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        moveDimension: {
          source: { sheetId, dimension: 'COLUMNS', startIndex, endIndex },
          destinationIndex,
        },
      }],
    },
  })

  // Where the block ends up after the move (moving right shifts it left by its own width).
  const width = endIndex - startIndex
  const finalStart = destinationIndex > startIndex ? destinationIndex - width : destinationIndex
  return {
    spreadsheetId,
    sheet: target.title,
    sheetId,
    moved: `${indexToColumn(startIndex)}${width > 1 ? `:${indexToColumn(lastIndex)}` : ''}`,
    destinationIndex,
    nowAt: `${indexToColumn(finalStart)}${width > 1 ? `:${indexToColumn(finalStart + width - 1)}` : ''}`,
  }
}

/** Parse "#RRGGBB" / "RRGGBB" / "#RGB" into a Sheets Color object (0-1 floats). */
function hexToColor(hex) {
  let h = String(hex).trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Invalid color "${hex}" (use hex like "#FFF2CC")`)
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  }
}

/**
 * Parse an A1 range ("Main!A2:K2", "B5", "C:C", "3:4") into a tab name and a 0-based,
 * end-exclusive GridRange (sheetId filled in by the caller). Open-ended sides are omitted.
 */
function parseA1Range(a1) {
  let tab
  let ref = String(a1).trim()
  const bang = ref.lastIndexOf('!')
  if (bang !== -1) {
    tab = ref.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'")
    ref = ref.slice(bang + 1)
  }
  const parseCell = (cell) => {
    const m = /^([A-Za-z]*)(\d*)$/.exec(cell)
    if (!m || (!m[1] && !m[2])) throw new Error(`Invalid A1 range "${a1}"`)
    return { col: m[1] ? columnToIndex(m[1]) : undefined, row: m[2] ? Number(m[2]) - 1 : undefined }
  }
  const [a, b = a] = ref.split(':')
  const start = parseCell(a)
  const end = parseCell(b)
  const grid = {}
  if (start.row !== undefined) grid.startRowIndex = start.row
  if (end.row !== undefined) grid.endRowIndex = end.row + 1
  if (start.col !== undefined) grid.startColumnIndex = start.col
  if (end.col !== undefined) grid.endColumnIndex = end.col + 1
  return { tab, grid }
}

/**
 * Set the background fill (and optionally the text color) of a range of cells.
 * Uses repeatCell with a narrow fields mask, so values, number formats, borders,
 * and other formatting are left untouched.
 *
 * @param {string} spreadsheetId
 * @param {string} range - A1 range, e.g. "Main!A5:K5". Tab defaults to the first tab if omitted.
 * @param {string} [backgroundColor] - Hex fill like "#FFF2CC", or "none" to clear the fill.
 * @param {string} [textColor] - Optional hex text color, or "none" to reset to default.
 */
export async function setCellColor(auth, spreadsheetId, range, backgroundColor, textColor) {
  if (!backgroundColor && !textColor) throw new Error('Provide backgroundColor and/or textColor')
  const sheets = google.sheets({ version: 'v4', auth })
  const { tab, grid } = parseA1Range(range)
  const target = await resolveSheetProps(sheets, spreadsheetId, tab)

  const isNone = (c) => String(c).trim().toLowerCase() === 'none'
  const format = {}
  const fields = []
  if (backgroundColor) {
    // Clearing the field in the mask (with no value) resets the fill to none.
    if (!isNone(backgroundColor)) format.backgroundColor = hexToColor(backgroundColor)
    fields.push('userEnteredFormat.backgroundColor')
  }
  if (textColor) {
    if (!isNone(textColor)) format.textFormat = { foregroundColor: hexToColor(textColor) }
    fields.push('userEnteredFormat.textFormat.foregroundColor')
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId: target.sheetId, ...grid },
          cell: { userEnteredFormat: format },
          fields: fields.join(','),
        },
      }],
    },
  })

  return {
    spreadsheetId,
    sheet: target.title,
    range: `${target.title}!${range.includes('!') ? range.slice(range.lastIndexOf('!') + 1) : range}`,
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(textColor ? { textColor } : {}),
  }
}

/** Convert a Sheets Color object to "#RRGGBB" (undefined stays undefined). */
function colorToHex(c) {
  if (!c) return undefined
  return '#' + ['red', 'green', 'blue']
    .map(k => Math.round((c[k] || 0) * 255).toString(16).padStart(2, '0'))
    .join('').toUpperCase()
}

/**
 * Read cell values WITH their formatting (fill color, text color, bold) for a range.
 * Companion to readSheetRange, which returns values only. Reports userEnteredFormat,
 * i.e. what was set directly on the cell (conditional-formatting results are not included).
 *
 * @param {string} spreadsheetId
 * @param {string} range - A1 range, e.g. "Main!A1:K5". Tab defaults to the first tab if omitted.
 * @param {boolean} [onlyFormatted=false] - If true, return only cells that carry a color or bold.
 */
export async function readSheetFormat(auth, spreadsheetId, range, onlyFormatted = false) {
  const sheets = google.sheets({ version: 'v4', auth })
  const { tab } = parseA1Range(range)
  const target = await resolveSheetProps(sheets, spreadsheetId, tab)
  const ref = range.includes('!') ? range.slice(range.lastIndexOf('!') + 1) : range
  const fullRange = `'${target.title.replace(/'/g, "''")}'!${ref}`

  const { data } = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [fullRange],
    includeGridData: true,
    fields: 'sheets.data(startRow,startColumn,rowData.values(formattedValue,userEnteredFormat(backgroundColor,textFormat(foregroundColor,bold))))',
  })

  const grid = data.sheets?.[0]?.data?.[0] || {}
  const startRow = grid.startRow || 0
  const startCol = grid.startColumn || 0
  const rows = []
  ;(grid.rowData || []).forEach((r, ri) => {
    const rowNum = startRow + ri + 1
    const cells = []
    ;(r.values || []).forEach((v, ci) => {
      const fmt = v.userEnteredFormat || {}
      const cell = {
        cell: `${indexToColumn(startCol + ci)}${rowNum}`,
        value: v.formattedValue ?? '',
      }
      const bg = colorToHex(fmt.backgroundColor)
      const fg = colorToHex(fmt.textFormat?.foregroundColor)
      // A plain white fill / black text is the default look; report it only when it differs.
      if (bg && bg !== '#FFFFFF') cell.backgroundColor = bg
      if (fg && fg !== '#000000') cell.textColor = fg
      if (fmt.textFormat?.bold) cell.bold = true
      const formatted = cell.backgroundColor || cell.textColor || cell.bold
      if (!onlyFormatted || formatted) cells.push(cell)
    })
    if (cells.length) rows.push({ row: rowNum, cells })
  })

  return { spreadsheetId, sheet: target.title, range: `${target.title}!${ref}`, rows }
}
