# Customer Portal API

The customer portal is served by the shared Pioneer API under `/api/customer`. Customer portal authentication is intentionally separate from staff/admin authentication. Customer identity and business-unit scope are derived from the HTTP-only customer session cookie; customer-facing requests never accept a customer ID as authorization context.

## Authentication

- `POST /api/customer/auth/register` — create a new portal customer and session. Body: `displayName`, `email`, `phone`, `password`, `siteKey`.
- `POST /api/customer/auth/login` — create a customer session. Body: `email`, `password`; `siteKey` is optional for single-site accounts.
- `POST /api/customer/auth/logout` — revoke the current customer session.
- `GET /api/customer/auth/me` — return the authenticated portal identity and customer record.

The production customer cookie is HTTP-only, Secure, SameSite=None, and partitioned. It uses `CUSTOMER_SESSION_COOKIE_NAME`, defaulting to `pioneer_customer_session`.

## Customer self-service

- `GET /api/customer/profile`
- `PATCH /api/customer/profile`
- `GET /api/customer/properties`
- `POST /api/customer/properties`
- `PATCH /api/customer/properties/:propertyId`
- `DELETE /api/customer/properties/:propertyId`
- `GET /api/customer/schedule?from=<ISO>&to=<ISO>`
- `GET /api/customer/schedule/availability?from=<ISO>&to=<ISO>`
- `POST /api/customer/schedule/bookings`
- `GET /api/customer/requests`
- `POST /api/customer/requests`
- `PATCH /api/customer/requests/:requestId/cancel`
- `GET /api/customer/billing`
- `GET /api/customer/billing/invoices/:invoiceId`

Billing is read-only until a payment processor is explicitly integrated. Existing admin invoice/payment workflows remain unchanged.

## Admin customer-portal operations

Routes are mounted beneath `/api/admin/business-units/:businessUnitId/customer-portal` and use the existing staff authentication and business-unit permissions.

- `GET /availability?from=<ISO>&to=<ISO>`
- `POST /availability`
- `PATCH /availability/:slotId`
- `GET /bookings`
- `PATCH /bookings/:bookingId`
- `GET /requests`
- `PATCH /requests/:requestId`

Confirming a customer booking creates the corresponding `schedule_entries` record. Cancelling or completing a confirmed booking updates that schedule entry as well.

## Account claiming

Self-registration creates a new customer record. It does not automatically attach a portal login to an existing customer merely because the email address matches; doing so without email/phone verification or an admin-issued invitation would allow unsafe account claiming. A verified claim/invitation flow can be added separately when existing customer history needs to be attached to portal accounts.
