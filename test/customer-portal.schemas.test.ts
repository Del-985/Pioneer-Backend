import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminBookingSlotCreateSchema,
  adminServiceRequestUpdateSchema,
  customerBookingCreateSchema,
  customerRegisterSchema,
  customerScheduleQuerySchema,
  customerServiceRequestCreateSchema,
} from '../src/modules/customer-portal/customer-portal.schemas.js';
import {
  canTransitionServiceRequest,
  toCustomerServiceRequestStatus,
} from '../src/modules/customer-portal/customer-service-request-status.js';

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
  const futureStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const futureEnd = new Date(Date.now() + 60 * 60 * 1000);
  assert.throws(() => adminBookingSlotCreateSchema.parse({
    startsAt: futureStart.toISOString(),
    endsAt: futureEnd.toISOString(),
  }));
});

test('admin availability cannot be published in the past', () => {
  const pastStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const pastEnd = new Date(Date.now() - 60 * 60 * 60 * 1000);
  assert.throws(() => adminBookingSlotCreateSchema.parse({
    startsAt: pastStart.toISOString(),
    endsAt: pastEnd.toISOString(),
  }));
});

test('service request updates support explicit accept and deny decisions', () => {
  assert.equal(adminServiceRequestUpdateSchema.parse({ status: 'accepted' }).status, 'accepted');
  assert.equal(adminServiceRequestUpdateSchema.parse({ status: 'denied' }).status, 'denied');
  assert.throws(() => adminServiceRequestUpdateSchema.parse({ status: 'approved' }));
});

test('service request workflow maps to stable customer-facing statuses', () => {
  assert.equal(toCustomerServiceRequestStatus('new'), 'pending');
  assert.equal(toCustomerServiceRequestStatus('in_review'), 'pending');
  assert.equal(toCustomerServiceRequestStatus('accepted'), 'accepted');
  assert.equal(toCustomerServiceRequestStatus('scheduled'), 'accepted');
  assert.equal(toCustomerServiceRequestStatus('completed'), 'accepted');
  assert.equal(toCustomerServiceRequestStatus('denied'), 'denied');
  assert.equal(toCustomerServiceRequestStatus('cancelled'), 'cancelled');
});

test('service request decisions follow a controlled lifecycle', () => {
  assert.equal(canTransitionServiceRequest('new', 'accepted'), true);
  assert.equal(canTransitionServiceRequest('in_review', 'denied'), true);
  assert.equal(canTransitionServiceRequest('accepted', 'scheduled'), true);
  assert.equal(canTransitionServiceRequest('scheduled', 'completed'), true);
  assert.equal(canTransitionServiceRequest('denied', 'accepted'), false);
  assert.equal(canTransitionServiceRequest('completed', 'in_review'), false);
});
