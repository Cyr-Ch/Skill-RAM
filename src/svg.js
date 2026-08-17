import { writeFile } from 'node:fs/promises';

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

export async function writeReceiptSvg(report, output) {
  const tax = report.loadedCatalogTokens >= 1000 ? `${(report.loadedCatalogTokens / 1000).toFixed(1)}k` : report.loadedCatalogTokens;
  const providerLabel = report.provider === 'all' ? 'Claude + Codex' : report.provider;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="SkillRAM tax receipt">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#09090b"/><stop offset="1" stop-color="#18181b"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="18"/></filter></defs>
  <rect width="1200" height="630" rx="36" fill="url(#bg)"/><circle cx="1080" cy="70" r="190" fill="#a3e635" opacity=".12" filter="url(#glow)"/>
  <text x="72" y="86" fill="#a3e635" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="27" font-weight="700">SKILLRAM / ${escape(providerLabel.toUpperCase())} RECEIPT</text>
  <text x="72" y="180" fill="#fafafa" font-family="Inter, ui-sans-serif, system-ui" font-size="52" font-weight="760">My ${escape(providerLabel)} skill catalog contains an</text>
  <text x="72" y="253" fill="#fafafa" font-family="Inter, ui-sans-serif, system-ui" font-size="64" font-weight="820"><tspan fill="#a3e635">estimated ${escape(tax)} activation tokens.</tspan></text>
  <line x1="72" y1="317" x2="1128" y2="317" stroke="#3f3f46"/>
  <text x="72" y="391" fill="#a1a1aa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="25">INSTALLED SKILLS</text><text x="72" y="444" fill="#fafafa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="43" font-weight="700">${report.loadedSkills.length}</text>
  <text x="410" y="391" fill="#a1a1aa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="25">DUPLICATE TOKENS</text><text x="410" y="444" fill="#fafafa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="43" font-weight="700">${report.duplicateTokens.toLocaleString()}</text>
  <text x="797" y="391" fill="#a1a1aa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="25">METHOD</text><text x="797" y="444" fill="#a3e635" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="34" font-weight="700">${escape(report.tokenEstimateMethod)}</text>
  <rect x="72" y="512" width="1056" height="64" rx="14" fill="#27272a"/><text x="104" y="553" fill="#d4d4d8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="23">npx skillram receipt</text><text x="1096" y="553" text-anchor="end" fill="#71717a" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="21">private · local · reproducible</text>
</svg>\n`;
  await writeFile(output, svg, 'utf8');
}
