import assert from 'node:assert/strict';
import test from 'node:test';
import { presentSpecialTransaction, specialTransactionType } from '../src/modules/bookkeeping/special-transaction.presentation.js';

test('sales tax journal prefixes map to human transaction types', () => {
  assert.equal(specialTransactionType('TAXSALE-ABC'), 'sales_tax_sale');
  assert.equal(specialTransactionType('TAXPAY-ABC'), 'sales_tax_payment');

  const sale = presentSpecialTransaction({ type: 'manual', entryNumber: 'TAXSALE-ABC' });
  assert.equal(sale.type, 'income');
  assert.equal(sale.salesTaxSale, true);

  const payment = presentSpecialTransaction({ type: 'manual', entryNumber: 'TAXPAY-ABC' });
  assert.equal(payment.type, 'sales_tax_payment');
  assert.equal(payment.salesTaxPayment, true);
});

test('ordinary manual journals remain manual', () => {
  const transaction = presentSpecialTransaction({ type: 'manual', entryNumber: 'JE-ABC' });
  assert.equal(transaction.type, 'manual');
  assert.equal(transaction.salesTaxSale, undefined);
  assert.equal(transaction.salesTaxPayment, undefined);
});
