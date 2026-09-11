import assert from 'node:assert/strict';
import test from 'node:test';
import {
  customerPasswordChangeSchema,
  customerProfileUpdateSchema,
} from '../src/modules/customer-portal/customer-portal.schemas.js';

test('customer profile accepts contact and notification preferences', () => {
  const parsed = customerProfileUpdateSchema.parse({
    displayName: 'Test Customer',
    email: 'customer@example.com',
    phone: '4195550100',
    preferredContactMethod: 'text',
    notifications: {
      serviceConfirmations: true,
      scheduleChanges: true,
      weatherUpdates: true,
      marketing: false,
    },
  });

  assert.equal(parsed.preferredContactMethod, 'text');
  assert.equal(parsed.notifications?.marketing, false);
});

test('customer profile rejects unsupported contact methods', () => {
  assert.throws(() => customerProfileUpdateSchema.parse({
    preferredContactMethod: 'carrier-pigeon',
  }));
});

test('customer password change requires a different 10-character password', () => {
  assert.throws(() => customerPasswordChangeSchema.parse({
    currentPassword: 'same-password',
    newPassword: 'same-password',
  }));
  assert.throws(() => customerPasswordChangeSchema.parse({
    currentPassword: 'old-password',
    newPassword: 'short',
  }));
  assert.equal(customerPasswordChangeSchema.parse({
    currentPassword: 'old-password',
    newPassword: 'new-password-123',
  }).newPassword, 'new-password-123');
});
