import { PROVIDERS } from './scan.js';

const integer = new Intl.NumberFormat('en-US');

export function formatTokens(value) {
  if (value >= 1000) return `~${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}k tokens`;
  return `~${integer.format(value)} tokens`;
}

function row(label, value, width = 50) {
  const available = width - 4;
  const maxValue = Math.max(1, available - label.length - 1);
  const shown = value.length > maxValue ? `${value.slice(0, Math.max(0, maxValue - 1))}…` : value;
  const gap = Math.max(1, available - label.length - shown.length);
  return `│ ${label}${' '.repeat(gap)}${shown} │`;
}

function box(title, rows, width = 50) {
  const side = width - 2 - title.length;
  const left = Math.floor(side / 2);
  const right = side - left;
  return [`╭${'─'.repeat(left)}${title}${'─'.repeat(right)}╮`, ...rows, `╰${'─'.repeat(width - 2)}╯`];
}

export function receiptText(report) {
  const width = 50;
  if (report.provider !== 'all') {
    return box(` YOUR ${report.provider.toUpperCase()} SKILL RECEIPT `, [
      row('Skills loaded in context', integer.format(report.loadedSkills.length), width),
      ...(report.skills.length > report.loadedSkills.length
        ? [row('Skill files on disk (incl. mirrors)', integer.format(report.skills.length), width)]
        : []),
      row('Installed plugins', integer.format(report.plugins.length), width),
      row('Estimated activation catalog', formatTokens(report.loadedCatalogTokens), width),
      row('Removable repeated body text', formatTokens(report.duplicateTokens), width),
      row('Largest activation entry', report.largest?.name ?? 'none', width),
      row('Estimate method', report.tokenEstimateMethod, width),
      ...(report.marketplaceSkills.length ? [row('', '', width), row('Marketplace skills (not active)', integer.format(report.marketplaceSkills.length), width)] : []),
    ], width).join('\n');
  }

  // Each harness has its own context window, so each gets its own receipt —
  // no single agent ever pays a summed activation catalog.
  const present = PROVIDERS.filter((provider) => report.providerBreakdown[provider]?.skills > 0);
  const boxes = present.map((provider) => {
    const breakdown = report.providerBreakdown[provider];
    return box(` ${provider.toUpperCase()} `, [
      row('Skills loaded in context', integer.format(breakdown.skills), width),
      ...(breakdown.skillFiles > breakdown.skills
        ? [row('Skill files on disk (incl. mirrors)', integer.format(breakdown.skillFiles), width)]
        : []),
      ...(breakdown.plugins ? [row('Installed plugins', integer.format(breakdown.plugins), width)] : []),
      row('Estimated activation catalog', formatTokens(breakdown.catalogTokens), width),
      row('Removable repeated body text', formatTokens(breakdown.duplicateTokens), width),
      row('Largest activation entry', breakdown.largest ?? 'none', width),
      ...(provider === 'claude' && report.marketplaceSkills.length
        ? [row('Marketplace skills (not active)', integer.format(report.marketplaceSkills.length), width)]
        : []),
    ], width);
  });
  const summary = box(' ALL HARNESSES ', [
    row('Harnesses with skills', integer.format(present.length), width),
    row('Skills across all harnesses', integer.format(report.loadedSkills.length), width),
    row('Estimate method', report.tokenEstimateMethod, width),
  ], width);
  if (!boxes.length) return summary.join('\n');
  return [...boxes, summary].map((entry) => entry.join('\n')).join('\n');
}

export function receiptData(report) {
  return {
    installedSkills: report.loadedSkills.length,
    skillFilesOnDisk: report.skills.length,
    installedPlugins: report.plugins.length,
    provider: report.provider,
    providerBreakdown: report.providerBreakdown,
    catalogTokens: report.loadedCatalogTokens,
    rawCatalogTokens: report.catalogTokens,
    duplicateTokens: report.duplicateTokens,
    largestOffender: report.largest?.name ?? null,
    tokenEstimateMethod: report.tokenEstimateMethod,
    scannedRoots: report.roots,
    marketplaceSkills: report.marketplaceSkills.length,
    marketplacePlugins: report.marketplacePlugins.length,
    marketplaceRoots: report.marketplaceRoots,
  };
}
