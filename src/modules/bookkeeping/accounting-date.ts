const DEFAULT_ACCOUNTING_TIME_ZONE = 'America/New_York';

export function currentAccountingDate(date = new Date()) {
  const timeZone = process.env.ACCOUNTING_TIME_ZONE?.trim() || DEFAULT_ACCOUNTING_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to resolve the accounting date.');
  return `${year}-${month}-${day}`;
}

export function generatedReversalEntryNumber(date = new Date()) {
  return `REV-${date.getTime().toString(36).toUpperCase()}`;
}
