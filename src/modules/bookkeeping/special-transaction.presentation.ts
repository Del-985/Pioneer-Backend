export type PresentedSpecialTransaction = {
  type: string;
  entryNumber?: string | null;
  splitIncome?: boolean;
  splitExpense?: boolean;
  ownerDraw?: boolean;
  loanReceived?: boolean;
  loanPayment?: boolean;
  [key: string]: unknown;
};

export function specialTransactionType(entryNumber: string | null | undefined) {
  const value = String(entryNumber ?? '').toUpperCase();
  if (value.startsWith('INCSPLIT-')) return 'income';
  if (value.startsWith('EXPSPLIT-')) return 'expense';
  if (value.startsWith('OWNERDRAW-')) return 'owner_draw';
  if (value.startsWith('LOANIN-')) return 'loan_received';
  if (value.startsWith('LOANPAY-')) return 'loan_payment';
  return null;
}

export function presentSpecialTransaction<T extends PresentedSpecialTransaction>(transaction: T): T {
  if (transaction.type !== 'manual') return transaction;
  const specialType = specialTransactionType(transaction.entryNumber);
  if (!specialType) return transaction;
  if (specialType === 'income') return { ...transaction, type: 'income', splitIncome: true } as T;
  if (specialType === 'expense') return { ...transaction, type: 'expense', splitExpense: true } as T;
  if (specialType === 'owner_draw') return { ...transaction, type: 'owner_draw', ownerDraw: true } as T;
  if (specialType === 'loan_received') return { ...transaction, type: 'loan_received', loanReceived: true } as T;
  return { ...transaction, type: 'loan_payment', loanPayment: true } as T;
}
