const amount = (value, symbol, approximate = false) => {
  const number = Number(value) || 0;
  return number > 0 ? `${approximate ? '≈' : ''}${symbol}${number.toFixed(4)}` : '';
};

export function costParts(bucket = {}) {
  return [
    { key: 'accounted-cny', label: '记账', currency: 'CNY', value: Number(bucket.cny) || 0, text: amount(bucket.cny, '¥') },
    { key: 'token-cny', label: '按单价计算', currency: 'CNY', value: Number(bucket.tokenCny) || 0, text: amount(bucket.tokenCny, '¥') },
    { key: 'estimated-cny', label: '估算', currency: 'CNY', value: Number(bucket.estCny) || 0, text: amount(bucket.estCny, '¥', true) },
    { key: 'estimated-usd', label: '估算', currency: 'USD', value: Number(bucket.estUsd) || 0, text: amount(bucket.estUsd, '$', true) },
  ].filter((part) => part.value > 0);
}

export function costTotals(bucket = {}) {
  const parts = costParts(bucket);
  return ['CNY', 'USD'].map((currency) => {
    const native = parts.filter((part) => part.currency === currency);
    const value = native.reduce((sum, part) => sum + part.value, 0);
    const approximate = native.some((part) => part.key.startsWith('estimated'));
    const symbol = currency === 'CNY' ? '¥' : '$';
    return value > 0 ? { currency, value, text: amount(value, symbol, approximate) } : null;
  }).filter(Boolean);
}

export function compactCost(bucket = {}) {
  return costTotals(bucket).map((part) => part.text).join(' · ') || '—';
}
