import path from 'node:path';
import { estimateTokens } from './scan.js';

// A compact stand-in for a full SKILL.md body, used by two callers:
//   - the L2 tier, so a skill the router ranked but did not load is still discoverable
//     instead of invisible, which makes a retrieval miss recoverable;
//   - the refresh pass, which re-states a long-resident skill's shape without paying for
//     the whole body a second time.
const HEADING = /^#{1,3}\s+(.+?)\s*#*$/;

function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  const close = lines.slice(1).findIndex((line) => line.trim() === '---');
  return close === -1 ? 0 : close + 2;
}

export function skillOutline(contents, { maxHeadings = 8 } = {}) {
  const lines = contents.split(/\r?\n/);
  const headings = [];
  for (const line of lines.slice(frontmatterEnd(lines))) {
    const match = HEADING.exec(line.trim());
    if (match && match[1]) headings.push(match[1].trim());
    if (headings.length >= maxHeadings) break;
  }
  return headings;
}

export function summarizeSkill(entry, contents, { maxHeadings = 8 } = {}) {
  const headings = skillOutline(contents, { maxHeadings });
  const description = (entry.description ?? '').trim();
  return { id: entry.id, name: entry.name, provider: entry.provider, description, headings };
}

function attribute(value) {
  return String(value).replace(/[&"<>]/g, (character) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]);
}

// Rendered as a distinct element so the agent can tell an available-but-unloaded skill
// from a loaded one, and knows it can ask for the full instructions.
export function formatSummaryContext(summaries) {
  if (!summaries.length) return '';
  return [
    'SkillRAM has these related skills available but not loaded. Ask for one by name to load its full instructions:',
    ...summaries.map(({ name, provider, description, headings }) => {
      const outline = headings.length ? `\n  Sections: ${headings.join(' · ')}` : '';
      return `\n<skillram-available name="${attribute(name)}" provider="${attribute(provider)}">\n  ${description}${outline}\n</skillram-available>`;
    }),
  ].join('\n');
}

export function formatRefreshContext(refreshed) {
  if (!refreshed.length) return '';
  return [
    'SkillRAM is restating skills loaded earlier in this session that remain relevant:',
    ...refreshed.map(({ entry, summary }) => {
      const outline = summary.headings.length ? `\n  Sections: ${summary.headings.join(' · ')}` : '';
      return `\n<skillram-refresh name="${attribute(entry.name)}" provider="${attribute(entry.provider)}" root="${attribute(path.dirname(entry.vaultSkillFile))}">\n  ${summary.description}${outline}\n</skillram-refresh>`;
    }),
  ].join('\n');
}

// Cache-line granularity: a memory system fetches the line containing an address, not the
// whole page. Bodies are already chunked for retrieval but loaded whole, so a large skill
// can be narrowed to the sections a prompt actually matches.
//
// Off by default and gated behind a size threshold on purpose: many skills are only correct
// as a complete procedure, and dropping a step is a worse failure than spending the tokens.
// Frontmatter and the preamble are always kept so the skill's identity survives the trim.
export function selectSections(contents, query, { maxTokens = 1200, minKeep = 1 } = {}) {
  const lines = contents.split(/\r?\n/);
  const start = frontmatterEnd(lines);
  const header = lines.slice(0, start);
  const sections = [];
  let current = { heading: '', lines: [] };
  for (const line of lines.slice(start)) {
    if (/^##\s+/.test(line.trim())) {
      sections.push(current);
      current = { heading: line, lines: [line] };
    } else current.lines.push(line);
  }
  sections.push(current);
  if (sections.length <= minKeep + 1) return contents;

  const [preamble, ...rest] = sections;
  const terms = new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const scored = rest.map((section, position) => {
    const words = new Set(section.lines.join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    let overlap = 0;
    for (const term of terms) if (words.has(term)) overlap += 1;
    return { section, position, overlap };
  }).sort((left, right) => right.overlap - left.overlap || left.position - right.position);

  const kept = [];
  let spent = estimateTokens([...header, ...preamble.lines].join('\n'));
  for (const candidate of scored) {
    const cost = estimateTokens(candidate.section.lines.join('\n'));
    if (kept.length >= minKeep && spent + cost > maxTokens) continue;
    kept.push(candidate);
    spent += cost;
  }
  if (kept.length === rest.length) return contents;
  const ordered = kept.sort((left, right) => left.position - right.position).map(({ section }) => section.lines.join('\n'));
  const omitted = rest.length - kept.length;
  return [...header, preamble.lines.join('\n'), ...ordered,
    `\n<!-- SkillRAM loaded ${kept.length} of ${rest.length} sections; ${omitted} omitted as unrelated to this prompt. Ask for the full skill if a step is missing. -->`,
  ].join('\n');
}

export function summaryTokens(summaries) {
  return summaries.reduce((sum, summary) => sum + estimateTokens(`${summary.name} ${summary.description} ${summary.headings.join(' ')}`), 0);
}
