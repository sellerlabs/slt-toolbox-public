// Shape helpers for the Linear MCP.
//
// Linear's GraphQL responses nest every relation one object deep
// ({ state: { name, type }, assignee: { name }, team: { key } }) and wrap every
// list in { nodes: [...] }. Handing that to a model burns tokens on structure
// rather than content, so everything is flattened to plain scalars here.
//
// These live in their own file so they can be unit tested directly (see
// test-normalizer.mjs) without booting a server or holding an API key.

// Linear priority is an int 0-4. The UI shows words, the API returns numbers,
// and a model reading "priority: 1" has no way to know 1 is the MOST urgent.
export const PRIORITY_LABELS = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

// Reverse lookup so callers can pass either the word or the number.
const PRIORITY_BY_NAME = new Map(
  Object.entries(PRIORITY_LABELS).map(([n, label]) => [label.toLowerCase(), Number(n)])
);

export function parsePriority(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 4) {
      throw new Error(`Priority must be an integer 0-4 (0 None, 1 Urgent, 2 High, 3 Medium, 4 Low). Got: ${value}`);
    }
    return value;
  }
  const key = String(value).trim().toLowerCase();
  if (/^[0-4]$/.test(key)) return Number(key);
  if (PRIORITY_BY_NAME.has(key)) return PRIORITY_BY_NAME.get(key);
  throw new Error(
    `Unknown priority "${value}". Use 0-4 or one of: ${Object.values(PRIORITY_LABELS).join(', ')}.`
  );
}

// Unwrap Linear's { nodes: [...] } list wrapper. Tolerates a bare array and
// null, so callers never need a guard.
export function nodes(connection) {
  if (!connection) return [];
  if (Array.isArray(connection)) return connection;
  return connection.nodes || [];
}

// Drop keys whose value is null or undefined. Linear returns an explicit null
// for every unset relation, which is pure noise in a tool response.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export function flattenIssue(issue) {
  if (!issue) return null;
  return compact({
    id: issue.id,
    // The human-facing key (ENG-123). This is what someone pastes in chat, and
    // what the issue(id:) query accepts, so it matters more than the uuid.
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,

    state: issue.state?.name,
    // stateType is the stable machine value (triage/backlog/unstarted/started/
    // completed/canceled). State NAMES are per-team and renameable, so any
    // logic keying off "is this done" must use stateType, not state.
    stateType: issue.state?.type,

    priority: issue.priority,
    priorityLabel: PRIORITY_LABELS[issue.priority],

    assignee: issue.assignee?.name,
    assigneeId: issue.assignee?.id,
    creator: issue.creator?.name,

    team: issue.team?.key,
    teamId: issue.team?.id,
    project: issue.project?.name,
    projectId: issue.project?.id,
    cycle: issue.cycle?.name || (issue.cycle?.number != null ? `Cycle ${issue.cycle.number}` : undefined),

    parent: issue.parent?.identifier,
    labels: nodes(issue.labels).map((l) => l.name),

    estimate: issue.estimate,
    dueDate: issue.dueDate,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    completedAt: issue.completedAt,
    canceledAt: issue.canceledAt,
  });
}

export function flattenProject(project) {
  if (!project) return null;
  return compact({
    id: project.id,
    name: project.name,
    description: project.description,
    url: project.url,
    state: project.state,
    // 0..1 in the API. Expose a percent too, since every human reference to
    // project progress is a percentage.
    progress: project.progress,
    progressPercent: typeof project.progress === 'number' ? Math.round(project.progress * 100) : undefined,
    health: project.health,
    lead: project.lead?.name,
    teams: nodes(project.teams).map((t) => t.key),
    startDate: project.startDate,
    targetDate: project.targetDate,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    completedAt: project.completedAt,
  });
}

export function flattenTeam(team) {
  if (!team) return null;
  return compact({
    id: team.id,
    key: team.key,
    name: team.name,
    description: team.description,
    private: team.private,
    issueCount: team.issueCount,
  });
}

export function flattenCycle(cycle) {
  if (!cycle) return null;
  return compact({
    id: cycle.id,
    number: cycle.number,
    name: cycle.name || (cycle.number != null ? `Cycle ${cycle.number}` : undefined),
    team: cycle.team?.key,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    completedAt: cycle.completedAt,
    progress: cycle.progress,
  });
}

export function flattenComment(comment) {
  if (!comment) return null;
  return compact({
    id: comment.id,
    body: comment.body,
    user: comment.user?.name,
    url: comment.url,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  });
}

export function flattenUser(user) {
  if (!user) return null;
  return compact({
    id: user.id,
    name: user.name,
    displayName: user.displayName,
    email: user.email,
    active: user.active,
    admin: user.admin,
  });
}

export function flattenState(state) {
  if (!state) return null;
  return compact({
    id: state.id,
    name: state.name,
    type: state.type,
    position: state.position,
    team: state.team?.key,
  });
}

export function flattenLabel(label) {
  if (!label) return null;
  return compact({
    id: label.id,
    name: label.name,
    color: label.color,
    team: label.team?.key,
  });
}

// A paged result carries its cursor back out so the caller can continue without
// re-deriving it. Returning the cursor only when there IS a next page keeps a
// complete result from looking paginated.
export function paged(connection, mapFn) {
  const items = nodes(connection).map(mapFn).filter(Boolean);
  const info = connection?.pageInfo;
  const out = { count: items.length, items };
  if (info?.hasNextPage) {
    out.hasMore = true;
    out.cursor = info.endCursor;
  }
  return out;
}
