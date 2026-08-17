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

export function receiptText(report) {
  const width = 50;
  const providerLabel = report.provider === 'all' ? 'CLAUDE + CODEX' : report.provider.toUpperCase();
  const title = ` YOUR ${providerLabel} SKILL RECEIPT `;
  const side = width - 2 - title.length;
  const left = Math.floor(side / 2);
  const right = side - left;
  const lines = [
    `╭${'─'.repeat(left)}${title}${'─'.repeat(right)}╮`,
    ...(report.provider === 'all' ? [
      row('Claude skills', `${integer.format(report.providerBreakdown.claude.skills)} · ${formatTokens(report.providerBreakdown.claude.catalogTokens)}`, width),
      row('Codex skills', `${integer.format(report.providerBreakdown.codex.skills)} · ${formatTokens(report.providerBreakdown.codex.catalogTokens)}`, width),
      row('', '', width),
    ] : []),
    row('Installed skills', integer.format(report.skills.length), width),
    row('Installed plugins', integer.format(report.plugins.length), width),
    row('Estimated activation catalog', formatTokens(report.catalogTokens), width),
    row('Removable repeated body text', formatTokens(report.duplicateTokens), width),
    row('Largest activation entry', report.largest?.name ?? 'none', width),
    row('Estimate method', report.tokenEstimateMethod, width),
    ...(report.marketplaceSkills.length ? [row('', '', width), row('Marketplace skills (not active)', integer.format(report.marketplaceSkills.length), width)] : []),
    `╰${'─'.repeat(width - 2)}╯`,
  ];
  return lines.join('\n');
}

export function receiptData(report) {
  return {
    installedSkills: report.skills.length,
    installedPlugins: report.plugins.length,
    provider: report.provider,
    providerBreakdown: report.providerBreakdown,
    catalogTokens: report.catalogTokens,
    duplicateTokens: report.duplicateTokens,
    largestOffender: report.largest?.name ?? null,
    tokenEstimateMethod: report.tokenEstimateMethod,
    scannedRoots: report.roots,
    marketplaceSkills: report.marketplaceSkills.length,
    marketplacePlugins: report.marketplacePlugins.length,
    marketplaceRoots: report.marketplaceRoots,
  };
}
