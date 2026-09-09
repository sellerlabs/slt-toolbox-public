/**
 * slides.js — Google Slides API tool implementations
 */

// Scoped clients instead of the `googleapis` meta-package — see note in gmail.js.
// This file uses both slides and drive (drive for folder placement).
import { slides as slidesApi } from '@googleapis/slides'
import { drive as driveApi } from '@googleapis/drive'
const google = { slides: slidesApi, drive: driveApi }

/**
 * Summarize a presentation's slides and their text placeholders.
 */
function summarizeSlides(presentation) {
  return (presentation.slides || []).map((s, i) => ({
    index: i,
    slideId: s.objectId,
    layout: s.slideProperties?.layoutObjectId,
    elements: (s.pageElements || [])
      .filter(el => el.shape)
      .map(el => ({
        objectId: el.objectId,
        placeholderType: el.shape.placeholder?.type || null,
        text: (el.shape.text?.textElements || [])
          .map(te => te.textRun?.content || '')
          .join('')
          .trim(),
      })),
  }))
}

/**
 * Create a new Google Slides presentation.
 * @param {string} title - Presentation title
 * @param {string} [folderId] - Optional Drive folder to move the new deck into
 */
export async function createPresentation(auth, title, folderId) {
  const slides = google.slides({ version: 'v1', auth })

  const { data } = await slides.presentations.create({ requestBody: { title } })
  const presentationId = data.presentationId

  if (folderId) {
    const drive = google.drive({ version: 'v3', auth })
    const { data: meta } = await drive.files.get({ fileId: presentationId, fields: 'parents' })
    const prevParents = (meta.parents || []).join(',')
    await drive.files.update({
      fileId: presentationId,
      addParents: folderId,
      removeParents: prevParents || undefined,
      fields: 'id, parents',
    })
  }

  return {
    id: presentationId,
    title: data.title,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    slides: summarizeSlides(data),
  }
}

/**
 * Read a presentation's structure: every slide, its element object IDs and current text.
 * Call this to discover the placeholder objectIds that slides_set_text needs.
 * @param {string} presentationId
 */
export async function getPresentation(auth, presentationId) {
  const slides = google.slides({ version: 'v1', auth })
  const { data } = await slides.presentations.get({ presentationId })
  return {
    id: data.presentationId,
    title: data.title,
    url: `https://docs.google.com/presentation/d/${data.presentationId}/edit`,
    slides: summarizeSlides(data),
  }
}

/**
 * Add a slide using a predefined layout, then return its new placeholder object IDs.
 * @param {string} presentationId
 * @param {string} [layout] - Predefined layout, e.g. TITLE, TITLE_AND_BODY, BLANK
 * @param {number} [insertionIndex] - Position to insert at. Omit to append at the end.
 */
export async function addSlide(auth, presentationId, layout, insertionIndex) {
  const slides = google.slides({ version: 'v1', auth })

  const createSlideReq = {
    slideLayoutReference: { predefinedLayout: layout || 'TITLE_AND_BODY' },
  }
  if (typeof insertionIndex === 'number') createSlideReq.insertionIndex = insertionIndex

  const { data } = await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: [{ createSlide: createSlideReq }] },
  })

  const slideId = data.replies?.[0]?.createSlide?.objectId

  // Re-read so the caller gets the real placeholder objectIds to write text into.
  const { data: pres } = await slides.presentations.get({ presentationId })
  const created = summarizeSlides(pres).find(s => s.slideId === slideId)

  return {
    presentationId,
    slideId,
    layout: layout || 'TITLE_AND_BODY',
    slide: created,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit#slide=id.${slideId}`,
  }
}

/**
 * Set text on one or more shape/placeholder objects.
 * Existing text in each target object is deleted first, so this is a replace, not an append.
 * @param {string} presentationId
 * @param {Array<{objectId: string, text: string}>} items
 */
export async function setSlideText(auth, presentationId, items) {
  const slides = google.slides({ version: 'v1', auth })

  // Find which targets currently hold text — deleteText on an empty shape is an error.
  const { data: pres } = await slides.presentations.get({ presentationId })
  const hasText = new Set()
  for (const s of summarizeSlides(pres)) {
    for (const el of s.elements) {
      if (el.text) hasText.add(el.objectId)
    }
  }

  const requests = []
  for (const item of items) {
    if (hasText.has(item.objectId)) {
      requests.push({ deleteText: { objectId: item.objectId, textRange: { type: 'ALL' } } })
    }
    if (item.text) {
      requests.push({ insertText: { objectId: item.objectId, text: item.text, insertionIndex: 0 } })
    }
  }

  if (!requests.length) return { presentationId, updated: 0 }

  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests },
  })

  return {
    presentationId,
    updated: items.length,
    objectIds: items.map(i => i.objectId),
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
  }
}

/**
 * Delete a slide from a presentation.
 * @param {string} presentationId
 * @param {string} slideId - objectId of the slide to delete
 */
export async function deleteSlide(auth, presentationId, slideId) {
  const slides = google.slides({ version: 'v1', auth })
  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: [{ deleteObject: { objectId: slideId } }] },
  })
  return { presentationId, deletedSlideId: slideId }
}

/**
 * Add speaker notes to a slide.
 * @param {string} presentationId
 * @param {string} slideId - objectId of the slide
 * @param {string} text - Notes text (replaces any existing notes)
 */
export async function setSpeakerNotes(auth, presentationId, slideId, text) {
  const slides = google.slides({ version: 'v1', auth })

  const { data: pres } = await slides.presentations.get({ presentationId })
  const slide = (pres.slides || []).find(s => s.objectId === slideId)
  if (!slide) throw new Error(`Slide not found: ${slideId}`)

  const notesId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId
  if (!notesId) throw new Error(`No speaker notes shape on slide ${slideId}`)

  const existing = (slide.slideProperties.notesPage.pageElements || [])
    .find(el => el.objectId === notesId)
  const hasText = (existing?.shape?.text?.textElements || [])
    .map(te => te.textRun?.content || '').join('').trim()

  const requests = []
  if (hasText) requests.push({ deleteText: { objectId: notesId, textRange: { type: 'ALL' } } })
  if (text) requests.push({ insertText: { objectId: notesId, text, insertionIndex: 0 } })

  if (requests.length) {
    await slides.presentations.batchUpdate({ presentationId, requestBody: { requests } })
  }

  return { presentationId, slideId, speakerNotesObjectId: notesId, characters: text.length }
}
