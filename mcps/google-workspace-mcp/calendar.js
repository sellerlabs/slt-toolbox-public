/**
 * calendar.js — Google Calendar API tool implementations
 */

// Scoped client instead of the `googleapis` meta-package — see note in gmail.js.
import { calendar as calendarApi } from '@googleapis/calendar'
const google = { calendar: calendarApi }

/**
 * List calendar events within a date range.
 * Defaults to the next 7 days if no dates provided.
 */
export async function listCalendarEvents(auth, startDate, endDate, maxResults = 50) {
  const calendar = google.calendar({ version: 'v3', auth })

  const timeMin = startDate
    ? new Date(startDate).toISOString()
    : new Date().toISOString()

  const timeMax = endDate
    ? new Date(endDate).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  // Fetch all calendars the user has access to
  const { data: calList } = await calendar.calendarList.list({ minAccessRole: 'reader' })
  const calendars = calList.items || []

  // Query events from all calendars in parallel
  const results = await Promise.allSettled(
    calendars.map((cal) =>
      calendar.events.list({
        calendarId: cal.id,
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      }).then(({ data }) =>
        (data.items || []).map((e) => ({ ...formatEvent(e), calendarName: cal.summary }))
      )
    )
  )

  const allEvents = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)

  // Deduplicate by event id and sort by start time
  const seen = new Set()
  return allEvents
    .filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
    .sort((a, b) => new Date(a.start) - new Date(b.start))
}

/**
 * Create a new calendar event.
 */
export async function createCalendarEvent(auth, { title, start, end, description, attendees }) {
  const calendar = google.calendar({ version: 'v3', auth })

  const event = {
    summary: title,
    description: description || '',
    start: { dateTime: new Date(start).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(end).toISOString(), timeZone: 'UTC' },
  }

  if (attendees && attendees.length > 0) {
    event.attendees = attendees.map((email) => ({ email }))
  }

  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
    sendUpdates: attendees?.length > 0 ? 'all' : 'none',
  })

  return formatEvent(data)
}

/**
 * Update an existing calendar event.
 * `updates` is a partial object with any of: title, start, end, description, attendees
 */
export async function updateCalendarEvent(auth, eventId, updates) {
  const calendar = google.calendar({ version: 'v3', auth })

  const { data: existing } = await calendar.events.get({
    calendarId: 'primary',
    eventId,
  })

  const updated = { ...existing }
  if (updates.title) updated.summary = updates.title
  if (updates.description !== undefined) updated.description = updates.description
  if (updates.start) updated.start = { dateTime: new Date(updates.start).toISOString(), timeZone: 'UTC' }
  if (updates.end) updated.end = { dateTime: new Date(updates.end).toISOString(), timeZone: 'UTC' }
  if (updates.attendees) updated.attendees = updates.attendees.map((email) => ({ email }))

  const { data } = await calendar.events.update({
    calendarId: 'primary',
    eventId,
    requestBody: updated,
  })

  return formatEvent(data)
}

/**
 * Delete a calendar event.
 */
export async function deleteCalendarEvent(auth, eventId) {
  const calendar = google.calendar({ version: 'v3', auth })
  await calendar.events.delete({ calendarId: 'primary', eventId })
  return { deleted: true, eventId }
}

/**
 * Find free time slots on a given day (returns gaps between events).
 */
export async function findFreeTime(auth, date) {
  const calendar = google.calendar({ version: 'v3', auth })

  const dayStart = new Date(date)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  const { data: calList } = await calendar.calendarList.list({ minAccessRole: 'reader' })
  const calendarIds = (calList.items || []).map((c) => c.id)

  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    },
  })

  // Merge busy slots from all calendars
  const busy = Object.values(data.calendars || {}).flatMap((c) => c.busy || [])
  busy.sort((a, b) => new Date(a.start) - new Date(b.start))
  const freeSlots = []

  // Work hours: 8am–6pm
  const workStart = new Date(date)
  workStart.setHours(8, 0, 0, 0)
  const workEnd = new Date(date)
  workEnd.setHours(18, 0, 0, 0)

  let cursor = workStart

  for (const slot of busy) {
    const busyStart = new Date(slot.start)
    const busyEnd = new Date(slot.end)

    if (cursor < busyStart) {
      const gapMinutes = (busyStart - cursor) / 60000
      if (gapMinutes >= 30) {
        freeSlots.push({ start: cursor.toISOString(), end: busyStart.toISOString(), durationMinutes: gapMinutes })
      }
    }
    cursor = busyEnd > cursor ? busyEnd : cursor
  }

  if (cursor < workEnd) {
    const gapMinutes = (workEnd - cursor) / 60000
    if (gapMinutes >= 30) {
      freeSlots.push({ start: cursor.toISOString(), end: workEnd.toISOString(), durationMinutes: gapMinutes })
    }
  }

  return { date, busySlots: busy, freeSlots }
}

function formatEvent(event) {
  return {
    id: event.id,
    title: event.summary || '(no title)',
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    description: event.description || '',
    location: event.location || '',
    attendees: (event.attendees || []).map((a) => ({ email: a.email, status: a.responseStatus })),
    htmlLink: event.htmlLink || '',
    status: event.status || '',
  }
}
