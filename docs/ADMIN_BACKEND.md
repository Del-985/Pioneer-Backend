# Admin Backend

The Pioneer admin application uses the shared backend under `/api/admin`. There is no separate admin backend deployment and no URL-path API version.

All admin routes require the central session authentication established by `/api/auth/login`.

## Overview

`GET /api/admin/overview`

Returns scope-aware counts for legal entities, business units, users, sites, and unresolved contact submissions.

## Legal entities

- `GET /api/admin/legal-entities`
- `POST /api/admin/legal-entities`
- `PATCH /api/admin/legal-entities/:legalEntityId`

Legal-entity reads are scope-aware. Creating a new legal entity is platform-level because no existing entity scope can authorize creation. Updates require `legal_entities.write` for the target entity; with the initial role configuration this is effectively platform administration.

## Business units

- `GET /api/admin/business-units`
- `GET /api/admin/business-units?includeInactive=true`
- `POST /api/admin/business-units`
- `PATCH /api/admin/business-units/:businessUnitId`

The default list remains suitable for the admin company selector because it returns active, accessible business units. The `includeInactive=true` form is intended for management screens.

Creation and updates require `business_units.write` in the appropriate legal-entity/business-unit scope. A legal-entity administrator can therefore manage business units inside their own entity without gaining platform-wide rights.

## Users and access assignments

- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:userId`
- `GET /api/admin/users/:userId/role-assignments`
- `POST /api/admin/users/:userId/role-assignments`
- `DELETE /api/admin/users/:userId/role-assignments/:assignmentId`

User visibility is scope-aware. Creating a user without an initial scoped assignment requires platform-level `users.write`. A narrower administrator may create a user when the initial assignment is within a scope they are permitted to manage.

Global identity changes such as email, display name, and account enabled/disabled state currently require platform-level `users.write`. Scoped administrators manage access by assigning or removing scoped roles instead of altering the global identity.

The backend prevents disabling the final active platform administrator and prevents removal of the final active platform-administrator assignment.

## Role and permission catalog

- `GET /api/admin/access/roles`
- `GET /api/admin/access/permissions`

These routes expose the existing role/permission catalog for administration screens and assignment workflows. Platform roles are only exposed to platform-level role readers; legal-entity readers see legal-entity and business-unit roles.

Role-definition mutation is intentionally not exposed yet. The initial fixed roles are safer while the rest of the administration system is being established.

## Audit history

`GET /api/admin/audit`

Optional query parameters:

- `limit` — 1 to 200, default 50
- `offset` — default 0
- `action` — exact action filter
- `resourceType` — exact resource-type filter

Audit results are filtered by the caller's `audit.read` scope. Platform-level events are only visible to platform-scoped readers.

## Existing site administration

Site administration remains available under `/api/admin/sites/:siteKey` and uses the same session and scoped authorization system.

## Authorization model

Admin endpoints do not trust a frontend-selected business or legal entity as proof of access. The backend resolves the user's role assignments and required permission for the target scope before performing writes or returning scoped data.

The central scope hierarchy is:

```text
platform
  -> legal entity
       -> business unit
```

A platform permission applies downward. A legal-entity permission applies to that entity and its business units. A business-unit permission applies only to that business unit.
