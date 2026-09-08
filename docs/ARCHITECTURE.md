# Pioneer Platform Architecture

## Purpose

Pioneer Backend is the shared application backend for Pioneer Legacy Works. Public websites, the administration application, bookkeeping, and future internal tools are clients of this API rather than independent systems with their own copies of business data.

## Organizational model

`LegalEntity` is the legal and tax boundary. `BusinessUnit` is an operating division, brand, or line of business and must belong to exactly one legal entity.

```text
LegalEntity
    +-- BusinessUnit
    +-- BusinessUnit
    +-- BusinessUnit
```

A future legal entity can be added without adding another backend deployment.

## Identity and authorization

A `User` is a platform-wide identity. Access is granted using scoped roles:

- `platform`: applies across the Pioneer platform.
- `legal_entity`: applies only inside one legal entity.
- `business_unit`: applies only inside one business unit.

Roles contain permissions. The API must check both permission and scope for every protected request. A frontend-supplied legal entity or business unit identifier is request context, not proof of authorization.

The database also validates that a role assignment is attached to the correct kind of scope.

## Request context

Protected business-data requests will eventually resolve this context before entering module business logic:

```text
request
  -> authenticate user
  -> resolve requested legal entity/business unit
  -> verify scoped role assignment
  -> verify required permission
  -> execute module service
  -> write audit event where appropriate
```

Modules must not implement authorization by filtering an already-returned result set in the frontend.

## Module boundaries

The codebase is a modular monolith: one deployable service with explicit internal domains. This gives Pioneer one API and one database without turning the project into one undifferentiated route/controller layer.

Planned domains include:

- auth
- users and access
- legal entities
- business units
- customers and contacts
- files and forms
- scheduling and work orders
- estimates, invoices, and payments
- bookkeeping
- reporting
- audit
- integrations

Modules may share infrastructure, but business rules should remain inside the module that owns them.

## API conventions

All application routes live below `/api/v1`. Breaking API changes require a new API version or a controlled migration of every client.

Operational records that belong to a business must carry sufficient ownership information to enforce their legal-entity and business-unit boundaries at the backend/database layer.

## Bookkeeping integration

Bookkeeping is part of the same platform, not a disconnected ledger application. Operational events can later create accounting events and journal entries without synchronizing separate databases.

Example:

```text
Work Order -> Invoice -> Payment -> Accounting Event -> Journal Entry
```

Accounting writes remain subject to the same legal-entity/business-unit scope rules as the rest of the platform.

## Non-goals for the foundation

The initial platform foundation does not yet expose unauthenticated CRUD routes for legal entities, business units, users, or roles. Those endpoints should be added only alongside authentication, permission middleware, validation, and auditing.
