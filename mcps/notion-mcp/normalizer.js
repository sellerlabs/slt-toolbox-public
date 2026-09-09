// Pure data-shaping helpers for the Notion MCP.
//
// These live in their own module with no network and no transport so they can
// be unit tested directly (see test-normalizer.mjs). Importing the server
// module instead would boot a stdio transport and hang a test runner.

// ---------------------------------------------------------------------------
// Property normalizer, the reason this server exists.
//
// Notion returns properties as deeply nested typed objects: a title arrives as
// properties.Name.title[0].text.content, a number as properties.Price.number, a
// relation as an array of {id} objects. Handing that raw JSON to an LLM burns a
// large multiple of the tokens the values are worth and invites the model to
// hallucinate paths that do not exist. Every read path here flattens to plain
// JS values: { Name: "Acme", Price: 42, Tags: ["a","b"] }.
// ---------------------------------------------------------------------------
function richTextToPlain(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((t) => t?.plain_text ?? '').join('');
}

function flattenProperty(prop) {
  if (!prop || typeof prop !== 'object') return null;
  switch (prop.type) {
    case 'title':
      return richTextToPlain(prop.title);
    case 'rich_text':
      return richTextToPlain(prop.rich_text);
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name ?? null;
    case 'status':
      return prop.status?.name ?? null;
    case 'multi_select':
      return (prop.multi_select || []).map((s) => s.name);
    case 'date':
      if (!prop.date) return null;
      return prop.date.end ? { start: prop.date.start, end: prop.date.end } : prop.date.start;
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url;
    case 'email':
      return prop.email;
    case 'phone_number':
      return prop.phone_number;
    case 'people':
      return (prop.people || []).map((p) => p.name || p.id);
    case 'files':
      return (prop.files || []).map((f) => f.external?.url || f.file?.url || f.name);
    case 'relation':
      // Notion caps relation payloads at 25 references, permanently and by
      // design; has_more signals truncation. Surface it rather than silently
      // returning a short list that reads as complete.
      return {
        ids: (prop.relation || []).map((r) => r.id),
        truncated: prop.has_more === true,
        note: prop.has_more
          ? 'Notion returns at most 25 relation references per property. More exist.'
          : undefined,
      };
    case 'formula':
      return prop.formula?.[prop.formula?.type] ?? null;
    case 'rollup':
      if (prop.rollup?.type === 'array') return (prop.rollup.array || []).map(flattenProperty);
      return prop.rollup?.[prop.rollup?.type] ?? null;
    case 'created_time':
      return prop.created_time;
    case 'last_edited_time':
      return prop.last_edited_time;
    case 'created_by':
      return prop.created_by?.name || prop.created_by?.id || null;
    case 'last_edited_by':
      return prop.last_edited_by?.name || prop.last_edited_by?.id || null;
    case 'unique_id':
      return prop.unique_id
        ? `${prop.unique_id.prefix ? prop.unique_id.prefix + '-' : ''}${prop.unique_id.number}`
        : null;
    default:
      return prop[prop.type] ?? null;
  }
}

function flattenPage(page) {
  const properties = {};
  for (const [name, prop] of Object.entries(page.properties || {})) {
    const value = flattenProperty(prop);
    if (value !== undefined) properties[name] = value;
  }
  return {
    id: page.id,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: page.archived,
    parent: page.parent,
    properties,
  };
}

// Turn plain JS values from the caller back into Notion's typed property
// objects. Needs the database schema to know each property's type, which is why
// create/update fetch (and cache) the schema first.
function buildProperty(type, value) {
  switch (type) {
    case 'title':
      return { title: [{ text: { content: String(value) } }] };
    case 'rich_text':
      return { rich_text: [{ text: { content: String(value) } }] };
    case 'number':
      return { number: value === null ? null : Number(value) };
    case 'select':
      return { select: value === null ? null : { name: String(value) } };
    case 'status':
      return { status: value === null ? null : { name: String(value) } };
    case 'multi_select':
      return { multi_select: (Array.isArray(value) ? value : [value]).map((v) => ({ name: String(v) })) };
    case 'date': {
      if (value === null) return { date: null };
      if (typeof value === 'object') return { date: { start: value.start, end: value.end ?? null } };
      return { date: { start: String(value) } };
    }
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'url':
      return { url: value === null ? null : String(value) };
    case 'email':
      return { email: value === null ? null : String(value) };
    case 'phone_number':
      return { phone_number: value === null ? null : String(value) };
    case 'people':
      return { people: (Array.isArray(value) ? value : [value]).map((id) => ({ id: String(id) })) };
    case 'relation':
      return { relation: (Array.isArray(value) ? value : [value]).map((id) => ({ id: String(id) })) };
    default:
      throw new Error(`Property type "${type}" is not writable through this server.`);
  }
}

// Blocks flattened to readable markdown-ish lines rather than the raw recursive
// block tree, which is enormous relative to its information content.
function flattenBlock(block) {
  const type = block.type;
  const data = block[type] || {};
  const text = richTextToPlain(data.rich_text);
  const base = { id: block.id, type, has_children: block.has_children };
  switch (type) {
    case 'paragraph':
      return { ...base, text };
    case 'heading_1':
      return { ...base, text: `# ${text}` };
    case 'heading_2':
      return { ...base, text: `## ${text}` };
    case 'heading_3':
      return { ...base, text: `### ${text}` };
    case 'bulleted_list_item':
      return { ...base, text: `- ${text}` };
    case 'numbered_list_item':
      return { ...base, text: `1. ${text}` };
    case 'to_do':
      return { ...base, text: `[${data.checked ? 'x' : ' '}] ${text}`, checked: data.checked };
    case 'code':
      return { ...base, text, language: data.language };
    case 'quote':
      return { ...base, text: `> ${text}` };
    case 'callout':
      return { ...base, text };
    case 'child_page':
      return { ...base, text: data.title };
    case 'child_database':
      return { ...base, text: data.title };
    case 'divider':
      return { ...base, text: '---' };
    default:
      return { ...base, text: text || undefined };
  }
}

export { richTextToPlain, flattenProperty, flattenPage, buildProperty, flattenBlock };
