// Unit tests for the property normalizer, the core of this server.
//
// The normalizer is pure and network free, which is exactly why it lives in its
// own module: these run with no Notion token and no stdio transport.
// Run: node test-normalizer.mjs

import assert from 'node:assert/strict';

import {
  flattenProperty,
  flattenPage,
  buildProperty,
  richTextToPlain,
  flattenBlock,
} from './normalizer.js';

// --- richTextToPlain -------------------------------------------------------
assert.equal(richTextToPlain([{ plain_text: 'Hello ' }, { plain_text: 'world' }]), 'Hello world');
assert.equal(richTextToPlain(undefined), '');

// --- scalar property types -------------------------------------------------
assert.equal(flattenProperty({ type: 'title', title: [{ plain_text: 'Acme Corp' }] }), 'Acme Corp');
assert.equal(flattenProperty({ type: 'rich_text', rich_text: [{ plain_text: 'note' }] }), 'note');
assert.equal(flattenProperty({ type: 'number', number: 42 }), 42);
assert.equal(flattenProperty({ type: 'number', number: null }), null);
assert.equal(flattenProperty({ type: 'select', select: { name: 'Active' } }), 'Active');
assert.equal(flattenProperty({ type: 'select', select: null }), null);
assert.equal(flattenProperty({ type: 'status', status: { name: 'Done' } }), 'Done');
assert.equal(flattenProperty({ type: 'checkbox', checkbox: true }), true);
assert.equal(flattenProperty({ type: 'url', url: 'https://x.com' }), 'https://x.com');
assert.equal(flattenProperty({ type: 'email', email: 'a@b.com' }), 'a@b.com');

// --- array property types --------------------------------------------------
assert.deepEqual(
  flattenProperty({ type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] }),
  ['a', 'b']
);
assert.deepEqual(flattenProperty({ type: 'multi_select', multi_select: [] }), []);
assert.deepEqual(flattenProperty({ type: 'people', people: [{ name: 'Ada' }, { id: 'u2' }] }), ['Ada', 'u2']);

// --- date, single vs range -------------------------------------------------
assert.equal(flattenProperty({ type: 'date', date: { start: '2026-09-02', end: null } }), '2026-09-02');
assert.deepEqual(
  flattenProperty({ type: 'date', date: { start: '2026-09-01', end: '2026-09-05' } }),
  { start: '2026-09-01', end: '2026-09-05' }
);
assert.equal(flattenProperty({ type: 'date', date: null }), null);

// --- relation, including the 25-reference truncation signal ----------------
const rel = flattenProperty({ type: 'relation', relation: [{ id: 'p1' }, { id: 'p2' }], has_more: false });
assert.deepEqual(rel.ids, ['p1', 'p2']);
assert.equal(rel.truncated, false);

const relTruncated = flattenProperty({
  type: 'relation',
  relation: Array.from({ length: 25 }, (_, i) => ({ id: `p${i}` })),
  has_more: true,
});
assert.equal(relTruncated.truncated, true, 'has_more must surface as truncated');
assert.match(relTruncated.note, /25 relation references/);

// --- formula and rollup ----------------------------------------------------
assert.equal(flattenProperty({ type: 'formula', formula: { type: 'number', number: 7 } }), 7);
assert.equal(flattenProperty({ type: 'formula', formula: { type: 'string', string: 'x' } }), 'x');
assert.equal(flattenProperty({ type: 'rollup', rollup: { type: 'number', number: 3 } }), 3);
assert.deepEqual(
  flattenProperty({
    type: 'rollup',
    rollup: { type: 'array', array: [{ type: 'number', number: 1 }, { type: 'number', number: 2 }] },
  }),
  [1, 2]
);

// --- unique_id -------------------------------------------------------------
assert.equal(flattenProperty({ type: 'unique_id', unique_id: { prefix: 'TASK', number: 12 } }), 'TASK-12');
assert.equal(flattenProperty({ type: 'unique_id', unique_id: { prefix: null, number: 12 } }), '12');

// --- unknown type does not throw ------------------------------------------
assert.equal(flattenProperty({ type: 'some_future_type', some_future_type: 'v' }), 'v');
assert.equal(flattenProperty(null), null);

// --- full page flattening --------------------------------------------------
const page = flattenPage({
  id: 'page-1',
  url: 'https://notion.so/page-1',
  created_time: '2026-01-01T00:00:00.000Z',
  last_edited_time: '2026-01-02T00:00:00.000Z',
  archived: false,
  parent: { type: 'database_id', database_id: 'db-1' },
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Acme Corp' }] },
    Status: { type: 'status', status: { name: 'Active' } },
    MRR: { type: 'number', number: 1200 },
    Tags: { type: 'multi_select', multi_select: [{ name: 'vip' }] },
  },
});
assert.deepEqual(page.properties, { Name: 'Acme Corp', Status: 'Active', MRR: 1200, Tags: ['vip'] });
assert.equal(page.id, 'page-1');
assert.equal(page.parent.database_id, 'db-1');

// --- buildProperty, the write direction ------------------------------------
assert.deepEqual(buildProperty('title', 'Acme'), { title: [{ text: { content: 'Acme' } }] });
assert.deepEqual(buildProperty('number', '42'), { number: 42 });
assert.deepEqual(buildProperty('number', null), { number: null });
assert.deepEqual(buildProperty('select', 'Active'), { select: { name: 'Active' } });
assert.deepEqual(buildProperty('select', null), { select: null });
assert.deepEqual(buildProperty('multi_select', ['a', 'b']), { multi_select: [{ name: 'a' }, { name: 'b' }] });
assert.deepEqual(buildProperty('multi_select', 'a'), { multi_select: [{ name: 'a' }] }, 'scalar coerces to array');
assert.deepEqual(buildProperty('checkbox', 1), { checkbox: true });
assert.deepEqual(buildProperty('date', '2026-09-02'), { date: { start: '2026-09-02' } });
assert.deepEqual(buildProperty('date', { start: 'a', end: 'b' }), { date: { start: 'a', end: 'b' } });
assert.deepEqual(buildProperty('relation', ['p1']), { relation: [{ id: 'p1' }] });
assert.throws(() => buildProperty('rollup', 1), /not writable/, 'read-only types must be rejected');

// --- round trip: flatten then rebuild --------------------------------------
// Note the asymmetry, which is intentional and worth stating: buildProperty
// emits Notion's WRITE shape ({ text: { content } }), while flattenProperty
// reads Notion's RESPONSE shape, where Notion has added plain_text. So a round
// trip must pass the rebuilt value back through the same transformation Notion
// applies on read, rather than feeding write shape straight into the reader.
function asNotionResponse(type, built) {
  if (type === 'title' || type === 'rich_text') {
    const arr = built[type].map((t) => ({ ...t, plain_text: t.text.content }));
    return { type, [type]: arr };
  }
  return { type, ...built };
}

for (const [type, notionShape, plain] of [
  ['title', { type: 'title', title: [{ plain_text: 'Acme' }] }, 'Acme'],
  ['rich_text', { type: 'rich_text', rich_text: [{ plain_text: 'note' }] }, 'note'],
  ['number', { type: 'number', number: 42 }, 42],
  ['select', { type: 'select', select: { name: 'Active' } }, 'Active'],
  ['multi_select', { type: 'multi_select', multi_select: [{ name: 'a' }] }, ['a']],
  ['checkbox', { type: 'checkbox', checkbox: true }, true],
  ['url', { type: 'url', url: 'https://x.com' }, 'https://x.com'],
]) {
  const flat = flattenProperty(notionShape);
  assert.deepEqual(flat, plain, `flatten ${type}`);
  const rebuilt = buildProperty(type, flat);
  assert.deepEqual(flattenProperty(asNotionResponse(type, rebuilt)), plain, `round trip ${type}`);
}

// --- blocks ----------------------------------------------------------------
assert.equal(
  flattenBlock({ id: 'b1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Title' }] } }).text,
  '## Title'
);
assert.equal(
  flattenBlock({ id: 'b2', type: 'to_do', to_do: { rich_text: [{ plain_text: 'ship' }], checked: true } }).text,
  '[x] ship'
);
assert.equal(
  flattenBlock({ id: 'b3', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'item' }] } }).text,
  '- item'
);
assert.equal(flattenBlock({ id: 'b4', type: 'divider', divider: {} }).text, '---');

console.log('All normalizer tests passed.');
