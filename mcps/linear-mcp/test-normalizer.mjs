// Unit tests for the shaping layer. These need no API key and no network:
// normalizer.js is pure, which is the whole reason it is a separate file.
//
// Run: node test-normalizer.mjs

import assert from 'node:assert/strict';
import {
  flattenIssue,
  flattenProject,
  flattenCycle,
  parsePriority,
  nodes,
  paged,
  PRIORITY_LABELS,
} from './normalizer.js';

// --- nodes() ---------------------------------------------------------------
assert.deepEqual(nodes(null), []);
assert.deepEqual(nodes({ nodes: [1, 2] }), [1, 2]);
assert.deepEqual(nodes([3, 4]), [3, 4], 'a bare array should pass through');

// --- parsePriority() -------------------------------------------------------
assert.equal(parsePriority(undefined), undefined);
assert.equal(parsePriority(''), undefined);
assert.equal(parsePriority(1), 1);
assert.equal(parsePriority('2'), 2);
assert.equal(parsePriority('Urgent'), 1);
assert.equal(parsePriority('  low  '), 4);
assert.equal(parsePriority('None'), 0);
assert.throws(() => parsePriority(9), /0-4/);
assert.throws(() => parsePriority(1.5), /0-4/);
assert.throws(() => parsePriority('screaming'), /Unknown priority/);

// 0 is a real value, not absent. A truthiness bug here would silently drop
// "priority: None" from every write.
assert.equal(parsePriority(0), 0);

// --- flattenIssue() --------------------------------------------------------
const rawIssue = {
  id: 'uuid-1',
  identifier: 'ENG-123',
  title: 'Fix the thing',
  description: 'Details here',
  url: 'https://linear.app/x/issue/ENG-123',
  priority: 1,
  estimate: 3,
  dueDate: '2026-10-01',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  completedAt: null,
  canceledAt: null,
  state: { id: 's1', name: 'In Progress', type: 'started' },
  assignee: { id: 'u1', name: 'Ada' },
  creator: { id: 'u2', name: 'Grace' },
  team: { id: 't1', key: 'ENG', name: 'Engineering' },
  project: { id: 'p1', name: 'Q4 Platform' },
  cycle: { id: 'c1', number: 7, name: null },
  parent: { id: 'uuid-0', identifier: 'ENG-100' },
  labels: { nodes: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'urgent' }] },
};

const flat = flattenIssue(rawIssue);
assert.equal(flat.identifier, 'ENG-123');
assert.equal(flat.state, 'In Progress');
assert.equal(flat.stateType, 'started', 'stateType must survive: it is the only rename-proof signal');
assert.equal(flat.priority, 1);
assert.equal(flat.priorityLabel, 'Urgent');
assert.equal(flat.assignee, 'Ada');
assert.equal(flat.team, 'ENG');
assert.equal(flat.project, 'Q4 Platform');
assert.equal(flat.parent, 'ENG-100');
assert.deepEqual(flat.labels, ['bug', 'urgent']);
assert.equal(flat.cycle, 'Cycle 7', 'an unnamed cycle should fall back to its number');

// Nulls are dropped, not carried through as noise.
assert.ok(!('completedAt' in flat), 'null completedAt should be omitted');
assert.ok(!('canceledAt' in flat), 'null canceledAt should be omitted');

// A sparse issue must not throw on any missing relation.
const sparse = flattenIssue({ id: 'u', identifier: 'ENG-1', title: 'Bare' });
assert.equal(sparse.title, 'Bare');
assert.equal(sparse.labels.length, 0);
assert.ok(!('state' in sparse));
assert.equal(flattenIssue(null), null);

// priority 0 must keep its label rather than vanishing.
const p0 = flattenIssue({ id: 'u', identifier: 'ENG-2', title: 'x', priority: 0 });
assert.equal(p0.priority, 0);
assert.equal(p0.priorityLabel, 'None');

// --- flattenProject() ------------------------------------------------------
const proj = flattenProject({
  id: 'p1',
  name: 'Q4 Platform',
  progress: 0.4267,
  state: 'started',
  lead: { id: 'u1', name: 'Ada' },
  teams: { nodes: [{ id: 't1', key: 'ENG' }, { id: 't2', key: 'DES' }] },
});
assert.equal(proj.progressPercent, 43, 'progress should round to a whole percent');
assert.equal(proj.lead, 'Ada');
assert.deepEqual(proj.teams, ['ENG', 'DES']);

// progress 0 is meaningful (nothing done yet), not absent.
const zeroProj = flattenProject({ id: 'p2', name: 'New', progress: 0 });
assert.equal(zeroProj.progress, 0);
assert.equal(zeroProj.progressPercent, 0);

// --- flattenCycle() --------------------------------------------------------
assert.equal(flattenCycle({ id: 'c', number: 3 }).name, 'Cycle 3');
assert.equal(flattenCycle({ id: 'c', number: 3, name: 'Hardening' }).name, 'Hardening');

// --- paged() ---------------------------------------------------------------
const complete = paged({ nodes: [rawIssue], pageInfo: { hasNextPage: false, endCursor: 'abc' } }, flattenIssue);
assert.equal(complete.count, 1);
assert.ok(!('cursor' in complete), 'a complete result must not look paginated');

const partial = paged({ nodes: [rawIssue], pageInfo: { hasNextPage: true, endCursor: 'abc' } }, flattenIssue);
assert.equal(partial.hasMore, true);
assert.equal(partial.cursor, 'abc');

// --- priority table --------------------------------------------------------
// Guard the mapping itself: Linear's 1 = most urgent is counter-intuitive and
// an accidental reorder here would silently invert every triage decision.
assert.equal(PRIORITY_LABELS[1], 'Urgent');
assert.equal(PRIORITY_LABELS[4], 'Low');

console.log('normalizer: all assertions passed');
