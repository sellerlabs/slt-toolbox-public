import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { gql, LinearError, ISSUE_FIELDS, PROJECT_FIELDS, COMMENT_FIELDS } from './client.js';
import {
  flattenIssue,
  flattenProject,
  flattenTeam,
  flattenCycle,
  flattenComment,
  flattenUser,
  flattenState,
  flattenLabel,
  parsePriority,
  paged,
  nodes,
} from './normalizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from THIS folder (LINEAR_API_KEY). Never reach outside the MCP's
// own directory for config: that resolves in this workspace and breaks on any
// other machine, which is why several MCPs here are not publishable.
const dotenv = await import('dotenv');
dotenv.config({ path: join(__dirname, '.env') });

const DEFAULT_TEAM = (process.env.LINEAR_DEFAULT_TEAM || '').trim();

const server = new McpServer({ name: 'linear-mcp', version: '1.0.0' });

// --- helpers ---------------------------------------------------------------

function ok(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Wrap every handler so a LinearError surfaces as a clean message instead of a
// stack trace, and anything else still fails loudly rather than silently.
function handler(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof LinearError) {
        return { content: [{ type: 'text', text: `Linear MCP: ${err.message}` }], isError: true };
      }
      throw err;
    }
  };
}

// Teams are addressed by key ("ENG") in every human context but by uuid in the
// API. Resolve once and cache: team keys effectively never change within a
// process lifetime, and re-resolving would waste a request per call.
const teamIdCache = new Map();

async function resolveTeamId(keyOrId) {
  const raw = (keyOrId || DEFAULT_TEAM || '').trim();
  if (!raw) {
    throw new LinearError(
      'No team given and LINEAR_DEFAULT_TEAM is not set in .env. Pass team (e.g. "ENG") or set a default.'
    );
  }
  // Already a uuid.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) return raw;
  const cached = teamIdCache.get(raw.toUpperCase());
  if (cached) return cached;

  const data = await gql(
    `query TeamByKey($key: String!) {
       teams(filter: { key: { eqIgnoreCase: $key } }, first: 1) { nodes { id key name } }
     }`,
    { key: raw }
  );
  const team = nodes(data.teams)[0];
  if (!team) {
    const all = await gql(`query AllTeams { teams(first: 50) { nodes { key name } } }`);
    const known = nodes(all.teams).map((t) => t.key).join(', ') || '(none visible to this key)';
    throw new LinearError(`No team with key "${raw}". Teams visible to this API key: ${known}.`);
  }
  teamIdCache.set(team.key.toUpperCase(), team.id);
  return team.id;
}

// An issue is addressed by identifier ("ENG-123") almost everywhere a human is
// involved. Linear's issue(id:) accepts both that and the uuid, so pass through.
function issueRef(idOrIdentifier) {
  const raw = String(idOrIdentifier || '').trim();
  if (!raw) throw new LinearError('An issue id or identifier (e.g. "ENG-123") is required.');
  return raw;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

server.registerTool(
  'linear_whoami',
  {
    description:
      'Verify the Linear API key works and show who it belongs to, plus the teams it can see. Run this first when setting up or when calls start failing.',
    inputSchema: {},
  },
  handler(async () => {
    const data = await gql(
      `query Me {
         viewer { id name displayName email active admin }
         teams(first: 50) { nodes { id key name private issueCount } }
       }`
    );
    return ok({
      viewer: flattenUser(data.viewer),
      teams: nodes(data.teams).map(flattenTeam),
      defaultTeam: DEFAULT_TEAM || null,
    });
  })
);

server.registerTool(
  'linear_list_teams',
  {
    description: 'List the Linear teams this API key can see, with their keys (ENG, DES) and issue counts.',
    inputSchema: {},
  },
  handler(async () => {
    const data = await gql(
      `query Teams { teams(first: 100) { nodes { id key name description private issueCount } } }`
    );
    const items = nodes(data.teams).map(flattenTeam);
    return ok({ count: items.length, items });
  })
);

server.registerTool(
  'linear_search_issues',
  {
    description:
      'Search and filter issues. Every filter is optional and they AND together. Returns flattened issues (state, assignee, team, labels as plain values). Use cursor from a previous result to page.',
    inputSchema: {
      query: z.string().optional().describe('Free-text search across title and description.'),
      team: z.string().optional().describe('Team key (e.g. "ENG") or uuid. Falls back to LINEAR_DEFAULT_TEAM.'),
      assignee: z.string().optional().describe('Assignee name or email. Use "me" for the API key owner.'),
      state: z.string().optional().describe('Workflow state NAME (e.g. "In Progress").'),
      stateType: z
        // 'duplicate' is a real Linear state type and ships in the default
        // workflow, but is missing from most docs and summaries of the API.
        // Leaving it out made a legitimate filter fail schema validation.
        .enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'])
        .optional()
        .describe('Stable state category. Prefer this over state for "is it done" logic, since state names are per-team and renameable.'),
      project: z.string().optional().describe('Project name (exact) or uuid.'),
      priority: z
        .union([z.number(), z.string()])
        .optional()
        .describe('0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. Accepts the word or the number.'),
      label: z.string().optional().describe('Label name the issue must carry.'),
      includeArchived: z.boolean().optional().describe('Include archived issues (default false).'),
      limit: z.number().min(1).max(100).optional().describe('Max issues to return (default 25, cap 100).'),
      cursor: z.string().optional().describe('Cursor from a previous result to fetch the next page.'),
    },
  },
  handler(async (a) => {
    const filter = {};
    if (a.team || DEFAULT_TEAM) {
      filter.team = { id: { eq: await resolveTeamId(a.team) } };
    }
    if (a.assignee) {
      if (a.assignee.toLowerCase() === 'me') {
        const me = await gql(`query { viewer { id } }`);
        filter.assignee = { id: { eq: me.viewer.id } };
      } else if (a.assignee.includes('@')) {
        filter.assignee = { email: { eqIgnoreCase: a.assignee } };
      } else {
        filter.assignee = { name: { containsIgnoreCase: a.assignee } };
      }
    }
    if (a.state) filter.state = { name: { eqIgnoreCase: a.state } };
    if (a.stateType) filter.state = { ...(filter.state || {}), type: { eq: a.stateType } };
    if (a.project) {
      filter.project = /^[0-9a-f]{8}-/i.test(a.project)
        ? { id: { eq: a.project } }
        : { name: { eqIgnoreCase: a.project } };
    }
    const priority = parsePriority(a.priority);
    if (priority !== undefined) filter.priority = { eq: priority };
    if (a.label) filter.labels = { name: { eqIgnoreCase: a.label } };

    const data = await gql(
      `query SearchIssues($filter: IssueFilter, $first: Int!, $after: String, $archived: Boolean) {
         issues(filter: $filter, first: $first, after: $after, includeArchived: $archived, orderBy: updatedAt) {
           nodes { ${ISSUE_FIELDS} }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      {
        filter: Object.keys(filter).length ? filter : undefined,
        first: a.limit || 25,
        after: a.cursor,
        archived: a.includeArchived ?? false,
      }
    );

    let result = paged(data.issues, flattenIssue);
    // Free-text is applied client-side: Linear's issue filter has no combined
    // title+description contains, and searchIssues() does not accept the same
    // structured filter set. Filtering here keeps one code path.
    if (a.query) {
      const q = a.query.toLowerCase();
      const items = result.items.filter(
        (i) =>
          (i.title || '').toLowerCase().includes(q) ||
          (i.description || '').toLowerCase().includes(q)
      );
      result = { ...result, count: items.length, items, filteredLocally: true };
    }
    return ok(result);
  })
);

server.registerTool(
  'linear_get_issue',
  {
    description:
      'Read one issue in full, including its comments, sub-issues and attachments. Accepts the human identifier (ENG-123) or the uuid.',
    inputSchema: {
      id: z.string().describe('Issue identifier (ENG-123) or uuid.'),
      includeComments: z.boolean().optional().describe('Include the comment thread (default true).'),
    },
  },
  handler(async (a) => {
    const withComments = a.includeComments !== false;
    const data = await gql(
      `query GetIssue($id: String!) {
         issue(id: $id) {
           ${ISSUE_FIELDS}
           children { nodes { id identifier title state { name type } } }
           ${withComments ? `comments(first: 100) { nodes { ${COMMENT_FIELDS} } }` : ''}
         }
       }`,
      { id: issueRef(a.id) }
    );
    if (!data.issue) throw new LinearError(`No issue found for "${a.id}".`);
    const out = flattenIssue(data.issue);
    out.subIssues = nodes(data.issue.children).map((c) => ({
      identifier: c.identifier,
      title: c.title,
      state: c.state?.name,
      stateType: c.state?.type,
    }));
    if (withComments) out.comments = nodes(data.issue.comments).map(flattenComment);
    return ok(out);
  })
);

server.registerTool(
  'linear_list_projects',
  {
    description: 'List projects, optionally scoped to a team. Returns progress as both a 0-1 fraction and a percent.',
    inputSchema: {
      team: z.string().optional().describe('Team key or uuid to scope to.'),
      state: z
        .string()
        .optional()
        .describe('Project state: planned, started, paused, completed, canceled.'),
      limit: z.number().min(1).max(100).optional(),
      cursor: z.string().optional(),
    },
  },
  handler(async (a) => {
    const filter = {};
    if (a.team) filter.accessibleTeams = { id: { eq: await resolveTeamId(a.team) } };
    if (a.state) filter.state = { eq: a.state };
    const data = await gql(
      `query Projects($filter: ProjectFilter, $first: Int!, $after: String) {
         projects(filter: $filter, first: $first, after: $after) {
           nodes { ${PROJECT_FIELDS} }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { filter: Object.keys(filter).length ? filter : undefined, first: a.limit || 50, after: a.cursor }
    );
    return ok(paged(data.projects, flattenProject));
  })
);

server.registerTool(
  'linear_get_project',
  {
    description: 'Read one project with its issue list and progress.',
    inputSchema: {
      id: z.string().describe('Project uuid, or the exact project name.'),
      includeIssues: z.boolean().optional().describe('Include the project issues (default true).'),
    },
  },
  handler(async (a) => {
    let projectId = a.id;
    if (!/^[0-9a-f]{8}-/i.test(a.id)) {
      const found = await gql(
        `query FindProject($name: String!) {
           projects(filter: { name: { eqIgnoreCase: $name } }, first: 1) { nodes { id } }
         }`,
        { name: a.id }
      );
      const hit = nodes(found.projects)[0];
      if (!hit) throw new LinearError(`No project named "${a.id}".`);
      projectId = hit.id;
    }
    const withIssues = a.includeIssues !== false;
    const data = await gql(
      `query GetProject($id: String!) {
         project(id: $id) {
           ${PROJECT_FIELDS}
           ${withIssues ? `issues(first: 100) { nodes { ${ISSUE_FIELDS} } }` : ''}
         }
       }`,
      { id: projectId }
    );
    if (!data.project) throw new LinearError(`No project found for "${a.id}".`);
    const out = flattenProject(data.project);
    if (withIssues) out.issues = nodes(data.project.issues).map(flattenIssue);
    return ok(out);
  })
);

server.registerTool(
  'linear_list_cycles',
  {
    description: 'List cycles (sprints) for a team, newest first. Use this to find the active cycle.',
    inputSchema: {
      team: z.string().optional().describe('Team key or uuid. Falls back to LINEAR_DEFAULT_TEAM.'),
      limit: z.number().min(1).max(50).optional(),
    },
  },
  handler(async (a) => {
    const teamId = await resolveTeamId(a.team);
    const data = await gql(
      `query Cycles($teamId: ID!, $first: Int!) {
         cycles(filter: { team: { id: { eq: $teamId } } }, first: $first, orderBy: updatedAt) {
           nodes { id number name startsAt endsAt completedAt progress team { id key } }
         }
       }`,
      { teamId, first: a.limit || 20 }
    );
    const items = nodes(data.cycles).map(flattenCycle);
    return ok({ count: items.length, items });
  })
);

server.registerTool(
  'linear_list_states',
  {
    description:
      'List a team’s workflow states with their stable type (triage/backlog/unstarted/started/completed/canceled). Needed before moving an issue, since state names are per-team.',
    inputSchema: {
      team: z.string().optional().describe('Team key or uuid. Falls back to LINEAR_DEFAULT_TEAM.'),
    },
  },
  handler(async (a) => {
    const teamId = await resolveTeamId(a.team);
    const data = await gql(
      `query States($teamId: ID!) {
         workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) {
           nodes { id name type position team { id key } }
         }
       }`,
      { teamId }
    );
    const items = nodes(data.workflowStates).map(flattenState).sort((x, y) => x.position - y.position);
    return ok({ count: items.length, items });
  })
);

server.registerTool(
  'linear_list_labels',
  {
    description: 'List issue labels, optionally scoped to a team.',
    inputSchema: {
      team: z.string().optional().describe('Team key or uuid to scope to.'),
    },
  },
  handler(async (a) => {
    const filter = a.team ? { team: { id: { eq: await resolveTeamId(a.team) } } } : undefined;
    const data = await gql(
      `query Labels($filter: IssueLabelFilter) {
         issueLabels(filter: $filter, first: 100) { nodes { id name color team { id key } } }
       }`,
      { filter }
    );
    const items = nodes(data.issueLabels).map(flattenLabel);
    return ok({ count: items.length, items });
  })
);

server.registerTool(
  'linear_list_users',
  {
    description: 'List workspace members, for resolving an assignee id from a name.',
    inputSchema: {
      query: z.string().optional().describe('Filter by name or email substring.'),
    },
  },
  handler(async (a) => {
    const data = await gql(
      `query Users { users(first: 250) { nodes { id name displayName email active admin } } }`
    );
    let items = nodes(data.users).map(flattenUser);
    if (a.query) {
      const q = a.query.toLowerCase();
      items = items.filter(
        (u) =>
          (u.name || '').toLowerCase().includes(q) ||
          (u.displayName || '').toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q)
      );
    }
    return ok({ count: items.length, items });
  })
);

// ---------------------------------------------------------------------------
// Write tools
//
// Completion is deliberately NOT a convenience flag anywhere in here. Moving an
// issue to a completed state goes through linear_update_issue with an explicit
// state, so closing work is always a stated intent rather than a side effect.
// ---------------------------------------------------------------------------

server.registerTool(
  'linear_create_issue',
  {
    description:
      'Create an issue. Only title and team are required. Returns the created issue including its new identifier (ENG-123).',
    inputSchema: {
      title: z.string().min(1).describe('Issue title.'),
      team: z.string().optional().describe('Team key or uuid. Falls back to LINEAR_DEFAULT_TEAM.'),
      description: z.string().optional().describe('Markdown body.'),
      assignee: z.string().optional().describe('Assignee name, email, uuid, or "me".'),
      state: z.string().optional().describe('Workflow state name. Defaults to the team’s default state.'),
      priority: z.union([z.number(), z.string()]).optional().describe('0 None, 1 Urgent, 2 High, 3 Medium, 4 Low.'),
      project: z.string().optional().describe('Project name or uuid to file it under.'),
      labels: z.array(z.string()).optional().describe('Label names to attach.'),
      parent: z.string().optional().describe('Parent issue identifier or uuid, to create a sub-issue.'),
      dueDate: z.string().optional().describe('Due date, ISO YYYY-MM-DD.'),
      estimate: z.number().optional().describe('Estimate points.'),
    },
  },
  handler(async (a) => {
    const teamId = await resolveTeamId(a.team);
    const input = { teamId, title: a.title };
    if (a.description) input.description = a.description;
    if (a.dueDate) input.dueDate = a.dueDate;
    if (a.estimate !== undefined) input.estimate = a.estimate;

    const priority = parsePriority(a.priority);
    if (priority !== undefined) input.priority = priority;

    if (a.assignee) input.assigneeId = await resolveUserId(a.assignee);
    if (a.state) input.stateId = await resolveStateId(teamId, a.state);
    if (a.project) input.projectId = await resolveProjectId(a.project);
    if (a.labels?.length) input.labelIds = await resolveLabelIds(teamId, a.labels);
    if (a.parent) input.parentId = await resolveIssueUuid(a.parent);

    const data = await gql(
      `mutation CreateIssue($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
       }`,
      { input }
    );
    if (!data.issueCreate?.success) throw new LinearError('Linear reported the issue create as unsuccessful.');
    return ok({ created: true, issue: flattenIssue(data.issueCreate.issue) });
  })
);

server.registerTool(
  'linear_update_issue',
  {
    description:
      'Update an existing issue. Only the fields you pass are changed. Moving an issue to a completed or canceled state is an ordinary state change here, so pass state explicitly when that is the intent.',
    inputSchema: {
      id: z.string().describe('Issue identifier (ENG-123) or uuid.'),
      title: z.string().optional(),
      description: z.string().optional().describe('Replaces the body entirely.'),
      state: z.string().optional().describe('Workflow state name to move to. Use linear_list_states to see options.'),
      assignee: z.string().optional().describe('Assignee name, email, uuid, or "me". Pass "none" to unassign.'),
      priority: z.union([z.number(), z.string()]).optional(),
      project: z.string().optional().describe('Project name or uuid. Pass "none" to remove from its project.'),
      labels: z.array(z.string()).optional().describe('Label names. REPLACES the existing label set.'),
      dueDate: z.string().optional().describe('ISO YYYY-MM-DD. Pass "none" to clear.'),
      estimate: z.number().optional(),
    },
  },
  handler(async (a) => {
    const uuid = await resolveIssueUuid(a.id);
    const issue = await gql(
      `query IssueTeam($id: String!) { issue(id: $id) { id team { id } } }`,
      { id: uuid }
    );
    const teamId = issue.issue?.team?.id;
    if (!teamId) throw new LinearError(`Could not resolve the team for issue "${a.id}".`);

    const input = {};
    if (a.title !== undefined) input.title = a.title;
    if (a.description !== undefined) input.description = a.description;
    if (a.estimate !== undefined) input.estimate = a.estimate;

    const priority = parsePriority(a.priority);
    if (priority !== undefined) input.priority = priority;

    if (a.dueDate !== undefined) input.dueDate = a.dueDate === 'none' ? null : a.dueDate;
    if (a.assignee !== undefined) {
      input.assigneeId = a.assignee === 'none' ? null : await resolveUserId(a.assignee);
    }
    if (a.project !== undefined) {
      input.projectId = a.project === 'none' ? null : await resolveProjectId(a.project);
    }
    if (a.state) input.stateId = await resolveStateId(teamId, a.state);
    if (a.labels) input.labelIds = await resolveLabelIds(teamId, a.labels);

    if (!Object.keys(input).length) {
      throw new LinearError('Nothing to update: pass at least one field to change.');
    }

    const data = await gql(
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
         issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
       }`,
      { id: uuid, input }
    );
    if (!data.issueUpdate?.success) throw new LinearError('Linear reported the issue update as unsuccessful.');
    return ok({ updated: Object.keys(input), issue: flattenIssue(data.issueUpdate.issue) });
  })
);

server.registerTool(
  'linear_create_comment',
  {
    description: 'Add a comment to an issue. Body is markdown.',
    inputSchema: {
      issue: z.string().describe('Issue identifier (ENG-123) or uuid.'),
      body: z.string().min(1).describe('Comment body, markdown.'),
    },
  },
  handler(async (a) => {
    const issueId = await resolveIssueUuid(a.issue);
    const data = await gql(
      `mutation CreateComment($input: CommentCreateInput!) {
         commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
       }`,
      { input: { issueId, body: a.body } }
    );
    if (!data.commentCreate?.success) throw new LinearError('Linear reported the comment create as unsuccessful.');
    return ok({ created: true, comment: flattenComment(data.commentCreate.comment) });
  })
);

server.registerTool(
  'linear_create_project',
  {
    description: 'Create a project and attach it to one or more teams.',
    inputSchema: {
      name: z.string().min(1),
      teams: z.array(z.string()).optional().describe('Team keys or uuids. Falls back to LINEAR_DEFAULT_TEAM.'),
      description: z.string().optional(),
      lead: z.string().optional().describe('Project lead: name, email, uuid, or "me".'),
      startDate: z.string().optional().describe('ISO YYYY-MM-DD.'),
      targetDate: z.string().optional().describe('ISO YYYY-MM-DD.'),
    },
  },
  handler(async (a) => {
    const teamKeys = a.teams?.length ? a.teams : [DEFAULT_TEAM].filter(Boolean);
    if (!teamKeys.length) {
      throw new LinearError('A project needs at least one team. Pass teams, or set LINEAR_DEFAULT_TEAM in .env.');
    }
    const teamIds = [];
    for (const t of teamKeys) teamIds.push(await resolveTeamId(t));

    const input = { name: a.name, teamIds };
    if (a.description) input.description = a.description;
    if (a.startDate) input.startDate = a.startDate;
    if (a.targetDate) input.targetDate = a.targetDate;
    if (a.lead) input.leadId = await resolveUserId(a.lead);

    const data = await gql(
      `mutation CreateProject($input: ProjectCreateInput!) {
         projectCreate(input: $input) { success project { ${PROJECT_FIELDS} } }
       }`,
      { input }
    );
    if (!data.projectCreate?.success) throw new LinearError('Linear reported the project create as unsuccessful.');
    return ok({ created: true, project: flattenProject(data.projectCreate.project) });
  })
);

// --- reference resolvers ---------------------------------------------------
// Each takes the human-friendly form a caller would naturally pass and returns
// the uuid the API needs, failing with the valid options rather than a bare id
// error when there is no match.

async function resolveUserId(ref) {
  const raw = String(ref).trim();
  if (/^[0-9a-f]{8}-/i.test(raw)) return raw;
  if (raw.toLowerCase() === 'me') {
    const me = await gql(`query { viewer { id } }`);
    return me.viewer.id;
  }
  const data = await gql(`query Users { users(first: 250) { nodes { id name displayName email } } }`);
  const all = nodes(data.users);
  const q = raw.toLowerCase();
  const hit =
    all.find((u) => (u.email || '').toLowerCase() === q) ||
    all.find((u) => (u.name || '').toLowerCase() === q) ||
    all.find((u) => (u.displayName || '').toLowerCase() === q) ||
    all.find((u) => (u.name || '').toLowerCase().includes(q));
  if (!hit) throw new LinearError(`No workspace member matching "${ref}". Use linear_list_users to see who exists.`);
  return hit.id;
}

async function resolveStateId(teamId, name) {
  const data = await gql(
    `query States($teamId: ID!) {
       workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name type } }
     }`,
    { teamId }
  );
  const all = nodes(data.workflowStates);
  const hit = all.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (!hit) {
    throw new LinearError(
      `No workflow state named "${name}" on this team. Available: ${all.map((s) => `${s.name} (${s.type})`).join(', ')}.`
    );
  }
  return hit.id;
}

async function resolveProjectId(ref) {
  const raw = String(ref).trim();
  if (/^[0-9a-f]{8}-/i.test(raw)) return raw;
  const data = await gql(
    `query FindProject($name: String!) {
       projects(filter: { name: { eqIgnoreCase: $name } }, first: 1) { nodes { id } }
     }`,
    { name: raw }
  );
  const hit = nodes(data.projects)[0];
  if (!hit) throw new LinearError(`No project named "${ref}". Use linear_list_projects to see what exists.`);
  return hit.id;
}

async function resolveLabelIds(teamId, names) {
  const data = await gql(
    `query Labels($teamId: ID!) {
       issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 200) { nodes { id name } }
     }`,
    { teamId }
  );
  // Workspace-level labels have no team, so fetch those too rather than
  // reporting a valid label as missing.
  const global = await gql(`query GlobalLabels { issueLabels(first: 200) { nodes { id name } } }`);
  const all = [...nodes(data.issueLabels), ...nodes(global.issueLabels)];
  const ids = [];
  for (const name of names) {
    const hit = all.find((l) => l.name.toLowerCase() === String(name).toLowerCase());
    if (!hit) {
      throw new LinearError(
        `No label named "${name}". Available: ${[...new Set(all.map((l) => l.name))].join(', ')}.`
      );
    }
    ids.push(hit.id);
  }
  return ids;
}

async function resolveIssueUuid(ref) {
  const raw = issueRef(ref);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) return raw;
  const data = await gql(`query IssueId($id: String!) { issue(id: $id) { id } }`, { id: raw });
  if (!data.issue) throw new LinearError(`No issue found for "${ref}".`);
  return data.issue.id;
}

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[linear-mcp] ready\n');
