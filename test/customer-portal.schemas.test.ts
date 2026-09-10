import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminBookingSlotCreateSchema,
  customerBookingCreateSchema,
  customerRegisterSchema,
  customerScheduleQuerySchema,
  customerServiceRequestCreateSchema,
} from '../src/modules/customer-portal/customer-portal.schemas.js';

test('customer registration enforces portal identity requirements', () => {
  const parsed = customerRegisterSchema.parse({
    displayName: 'Test Customer',
    email: 'customer@example.com',
    phone: '4195550100',
    password: 'long-enough-password',
    siteKey: 'pioneer-outdoor-services',
  });
  assert.equal(parsed.siteKey, 'pioneer-outdoor-services');
  assert.throws(() => customerRegisterSchema.parse({
    displayName: 'Test Customer',
    email: 'customer@example.com',
    phone: '4195550100',
    password: 'short',
    siteKey: 'pioneer-outdoor-services',
  }));
});

test('customer schedule range must move forward', () => {
  assert.throws(() => customerScheduleQuerySchema.parse({
    from: '2026-10-02T12:00:00.000Z',
    to: '2026-10-01T12:00:00.000Z',
  }));
});

test('customer booking and service request accept supported service types', () => {
  assert.equal(customerBookingCreateSchema.parse({
    slotId: '00000000-0000-4000-8000-000000000001',
    serviceType: 'snow-and-ice',
  }).serviceType, 'snow-and-ice');

  assert.equal(customerServiceRequestCreateSchema.parse({
    serviceType: 'salting',
    subject: 'Salt driveway',
    description: 'Please salt the driveway after clearing.',
  }).serviceType, 'salting');
});

test('admin availability requires a valid time range', () => {
  assert.throws(() => adminBookingSlotCreateSchema.parse({
    startsAt: '2026-10-01T14:00:00.000Z',
    endsAt: '2026-10-01T13:00:00.000Z',
  }));
});
